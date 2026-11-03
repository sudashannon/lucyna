import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createAgentSession } from "../src/sdk";
import { Settings } from "../src/config/settings";
import { AuthStorage } from "../src/session/auth-storage";
import { ModelRegistry } from "../src/config/model-registry";
import { RpcBackgroundTasks } from "../src/modes/rpc/rpc-background-tasks";
import { createDaemonBrokerClient } from "../src/launch/client";
import { daemonRuntimeDir } from "../src/launch/paths";

test("observing jobs leaves delivery intact, scopes ownership, and cancellation waits for the body to settle", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lucyna-jobs-"));
	const auth = await AuthStorage.create(path.join(cwd, "auth.db"));
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		modelRegistry: new ModelRegistry(auth, path.join(cwd, "models.yml")),
		settings: Settings.isolated({ "bash.autoBackground.enabled": true }),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	});
	const monitor = new RpcBackgroundTasks(session),
		manager = session.asyncJobManager!;
	const release = Promise.withResolvers<string>(),
		aborted = Promise.withResolvers<void>();
	try {
		const id = manager.register(
			"bash",
			"controlled command",
			async ({ signal, reportProgress }) => {
				signal.addEventListener("abort", () => aborted.resolve(), { once: true });
				await reportProgress("output-before-cancel");
				return release.promise;
			},
			{ ownerId: "Main" },
		);
		const foreign = manager.register("bash", "another owner", async () => release.promise, {
			ownerId: "NotThisSession",
		});
		await Bun.sleep(10);
		const snapshot = await monitor.snapshot(),
			task = snapshot.tasks.find(t => t.id === id)!;
		expect(task.output).toContain("output-before-cancel");
		expect(snapshot.tasks.some(t => t.id === foreign)).toBe(false);
		const delivery = manager.getDeliveryState();
		expect((await monitor.output({ kind: "job", taskId: id, startedAt: task.startedAt })).output).toContain(
			"output-before-cancel",
		);
		expect(manager.getDeliveryState()).toEqual(delivery);
		await expect(monitor.cancel({ kind: "job", taskId: id, startedAt: task.startedAt + 1 })).rejects.toThrow(
			"instance",
		);
		await expect(
			monitor.cancel({ kind: "job", taskId: foreign, startedAt: manager.getJob(foreign)!.startTime }),
		).rejects.toThrow("outside");
		expect(await monitor.cancel({ kind: "job", taskId: id, startedAt: task.startedAt })).toEqual({ accepted: true });
		await aborted.promise;
		expect((await monitor.snapshot()).tasks.find(t => t.id === id)?.status).toBe("stopping");
		expect(manager.getJob(foreign)?.status).toBe("running");
		release.resolve("done");
		await manager.getJob(id)!.promise;
		expect((await monitor.snapshot()).tasks.find(t => t.id === id)?.status).toBe("cancelled");
	} finally {
		release.resolve("cleanup");
		await session.dispose();
		auth.close();
		await fs.rm(cwd, { recursive: true, force: true });
	}
}, 20000);

test("passive service discovery creates no broker; scoped instance stop preserves peer services and replacements", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lucyna-daemons-"));
	const auth = await AuthStorage.create(path.join(cwd, "auth.db"));
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		modelRegistry: new ModelRegistry(auth, path.join(cwd, "models.yml")),
		settings: Settings.isolated(),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	});
	const monitor = new RpcBackgroundTasks(session);
	expect((await monitor.snapshot()).tasks).toEqual([]);
	await expect(fs.stat(path.join(daemonRuntimeDir(cwd), "broker.token"))).rejects.toThrow();
	const broker = await createDaemonBrokerClient(cwd, { idleGraceMs: 1000 });
	const spec = (name: string) => ({
		name,
		application: "/bin/sh",
		args: ["-c", "echo service-output; sleep 60"],
		cwd,
		env: {},
		pty: false,
		restart: "no" as const,
		persist: false,
		detached: false,
	});
	try {
		await broker.request({ op: "start", owner: session.sessionId, spec: spec("mine") });
		await broker.request({ op: "start", owner: "foreign-session", spec: spec("peer") });
		const rows = (await monitor.snapshot()).tasks;
		expect(rows.map(t => t.title)).toEqual(["mine"]);
		const task = rows[0]!;
		await Bun.sleep(30);
		expect((await monitor.output({ kind: "daemon", taskId: task.id, startedAt: task.startedAt })).output).toContain(
			"service-output",
		);
		await monitor.cancel({ kind: "daemon", taskId: task.id, startedAt: task.startedAt });
		const peers = await broker.request({ op: "list" });
		expect(peers.op === "list" && peers.daemons.find(d => d.name === "peer")?.state).toBe("running");
		await broker.request({ op: "start", owner: session.sessionId, spec: spec("mine"), replace: true });
		await expect(monitor.cancel({ kind: "daemon", taskId: task.id, startedAt: task.startedAt })).rejects.toThrow(
			"instance",
		);
	} finally {
		await broker.request({ op: "shutdown" });
		broker.close();
		await session.dispose();
		auth.close();
		await fs.rm(cwd, { recursive: true, force: true });
	}
}, 20000);
