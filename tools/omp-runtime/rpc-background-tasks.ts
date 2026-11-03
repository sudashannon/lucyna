import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../launch/client";
import type { AgentSession } from "../../session/agent-session";

export interface BackgroundTask {
	id: string;
	kind: "job" | "daemon";
	title: string;
	status: string;
	startedAt: number;
	endedAt?: number;
	command?: string;
	cwd?: string;
	ownerId?: string;
	agentId?: string;
	detail: string;
	cancellable: boolean;
	exitCode?: number;
	output?: string;
}
export interface BackgroundTaskSelector {
	taskId: string;
	kind: "job" | "daemon";
	startedAt: number;
}
const limit = 64 * 1024;

/** Read-only snapshots never consume a result, acknowledge delivery, or start a broker. */
export class RpcBackgroundTasks {
	readonly #session: AgentSession;
	constructor(session: AgentSession) {
		this.#session = session;
	}
	#jobs(): BackgroundTask[] {
		const tree = this.#session.getAsyncJobTree({ recentLimit: 100 });
		if (!tree) return [];
		return [...tree.running, ...tree.recent].flatMap(item => {
			const job = this.#session.asyncJobManager?.getJob(item.id);
			if (!job || job.foreground) return [];
			return [
				{
					id: job.id,
					kind: "job" as const,
					title: job.intent || job.label,
					status: job.status === "cancelled" && job.endTime === undefined ? "stopping" : job.status,
					startedAt: job.startTime,
					endedAt: job.endTime,
					command: job.process?.command,
					cwd: job.process?.cwd,
					ownerId: job.ownerId,
					agentId: job.agentId,
					output: (job.resultText ?? job.errorText ?? job.progressText ?? "").slice(-4096),
					detail: job.queued ? "排队中" : "",
					cancellable: job.status === "running",
					exitCode:
						typeof job.latestDetails?.exitCode === "number"
							? job.latestDetails.exitCode
							: job.type === "bash" && job.status === "completed"
								? 0
								: undefined,
				},
			];
		});
	}
	async #broker<T>(run: (client: DaemonBrokerClient) => Promise<T>): Promise<T> {
		const client = await createDaemonBrokerClient(this.#session.sessionManager.getCwd(), { existingOnly: true });
		try {
			return await run(client);
		} finally {
			client.close();
		}
	}
	async #daemons(client: DaemonBrokerClient): Promise<BackgroundTask[]> {
		const [list, ping] = await Promise.all([client.request({ op: "list" }), client.request({ op: "ping" })]);
		if (list.op !== "list") throw new Error("Invalid broker snapshot");
		const owner = this.#session.sessionId;
		return Promise.all(
			list.daemons
				.filter(d => d.owner === owner || d.owner === `${owner}-advisor`)
				.map(async d => {
					const description = await client.request({ op: "describe", name: d.name });
					const spec =
						description.op === "describe" && description.daemon.id === d.id ? description.spec : undefined;
					return {
						id: d.id,
						kind: "daemon",
						title: d.name,
						status: d.state,
						startedAt: d.startedAt,
						endedAt: d.exitedAt,
						command: spec ? [spec.application, ...spec.args].join(" ") : undefined,
						cwd: spec?.cwd,
						ownerId: d.owner,
						detail: d.readyPending?.length ? "等待服务就绪" : d.persist || d.detached ? "持续运行的后台服务" : "",
						exitCode: d.exitCode,
						cancellable:
							ping.op === "ping" &&
							ping.taskInstanceControl === true &&
							!["exited", "failed", "stopping"].includes(d.state),
					};
				}),
		);
	}
	async snapshot(): Promise<{ tasks: BackgroundTask[]; warning?: string }> {
		const jobs = this.#jobs();
		try {
			return { tasks: [...jobs, ...(await this.#broker(c => this.#daemons(c)))] };
		} catch (error) {
			const code = (error as { code?: string }).code;
			if (code === "ENOENT" || code === "ECONNREFUSED" || code === "BROKER_ABSENT") return { tasks: jobs };
			return { tasks: jobs, warning: error instanceof Error ? error.message : String(error) };
		}
	}
	#validate(selector: BackgroundTaskSelector): void {
		if (
			!selector ||
			typeof selector.taskId !== "string" ||
			!selector.taskId ||
			!["job", "daemon"].includes(selector.kind) ||
			!Number.isFinite(selector.startedAt)
		)
			throw new Error("A task instance is required");
	}
	#match(tasks: BackgroundTask[], selector: BackgroundTaskSelector): BackgroundTask {
		const task = tasks.find(
			t => t.id === selector.taskId && t.kind === selector.kind && t.startedAt === selector.startedAt,
		);
		if (!task) throw new Error("Task has ended, changed instance, or is outside this session");
		return task;
	}
	async output(selector: BackgroundTaskSelector): Promise<{ output: string; exitCode?: number }> {
		this.#validate(selector);
		if (selector.kind === "job") {
			const task = this.#match(this.#jobs(), selector),
				job = this.#session.asyncJobManager?.getJob(task.id);
			return {
				output: (job?.resultText ?? job?.errorText ?? job?.progressText ?? "").slice(-limit),
				exitCode: task.exitCode,
			};
		}
		return this.#broker(async client => {
			const task = this.#match(await this.#daemons(client), selector);
			const logs = await client.request({
				op: "logs",
				name: task.title,
				lines: 300,
				head: false,
				follow: false,
				renderTerminalRows: true,
				timeoutMs: 0,
			});
			// Logs are addressed by name in the broker: verify generation after reading.
			this.#match(await this.#daemons(client), selector);
			if (logs.op !== "logs") throw new Error("Invalid broker output");
			return { output: (logs.terminalRows?.join("\n") ?? logs.text).slice(-limit), exitCode: task.exitCode };
		});
	}
	async cancel(selector: BackgroundTaskSelector): Promise<{ accepted: boolean }> {
		this.#validate(selector);
		if (selector.kind === "job") {
			const task = this.#match(this.#jobs(), selector);
			// Membership is checked against the owning session's descendant tree.
			return {
				accepted:
					task.cancellable && this.#session.asyncJobManager?.cancel(task.id, { ownerId: task.ownerId }) === true,
			};
		}
		return this.#broker(async client => {
			const task = this.#match(await this.#daemons(client), selector);
			if (!task.cancellable) throw new Error("Broker cannot safely stop this task instance");
			await client.request({ op: "stop", name: task.title, id: task.id, timeoutMs: 1500 });
			return { accepted: true };
		});
	}
}
