declare module "@cloudflare/sandbox" {
  export class Sandbox {}

  export interface SandboxExecResult {
    success: boolean;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  }

  export interface SandboxClient {
    exec(command: string): Promise<SandboxExecResult>;
    readFile(path: string): Promise<{ content: string }>;
  }

  export function getSandbox(namespace: DurableObjectNamespace, id: string): SandboxClient;
  export function proxyToSandbox(request: Request, env: unknown): Promise<Response | null>;
}
