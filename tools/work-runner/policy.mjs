// Explicitly loaded service policy. Never installed into the user's global profile.
// OMP --no-tools alone does not exclude late MCP or auto-learn registrations.
export const allowed = new Set(['list_work_files','read_work_file','write_work_file','verify_work','ask_work_user','goal',
  'search_work_files','list_work_skills','read_work_skill','read_work_knowledge','run_work_command','inspect_work_git']);
export function guard(event) {
  if (!allowed.has(event.toolName)) return {block:true,reason:'This background run only permits its Work-local host tools.'};
  if (event.toolName==='goal'&&!['get','complete'].includes(event.input?.op)) return {block:true,reason:'Only the host may create, resume or drop this budgeted goal.'};
}
export default function policy(pi) {
  // Restored goal modes can replace the active set. Re-enable the registered
  // host tools as well as hiding late MCP tools; filtering only active names
  // would permanently lose Work tools after a resume.
  const restrict=()=>pi.setActiveTools(pi.getAllTools().map(tool=>tool.name).filter(name=>allowed.has(name)));
  pi.on('tool_call',guard);
  pi.on('before_agent_start',async()=>{await restrict();});
  pi.registerCommand('lucyna-file-scope',{
    description:'Apply the service-owned Work file policy without invoking a model',
    handler:async(_args,ctx)=>{await restrict();ctx.ui.notify('lucyna-file-scope:v1','info');},
  });
}
