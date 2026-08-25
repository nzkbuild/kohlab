export interface Workspace {
  id: string;
  repo: string;
  task: string;
  agent: string;
  created: number;
  started: number | null;
  stopped: number | null;
  /** json payload given to the agent CLI at launch (may be absent) */
  payload?: string;
  /** read-only share token; link is <host>/?share=<token> */
  share?: string;
}
