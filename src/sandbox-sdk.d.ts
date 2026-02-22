declare module "@cloudflare/sandbox" {
  export class Sandbox {}

  export interface SandboxExecResult {
    success: boolean;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  }

  export interface SandboxClient {
    exec(command: string, options?: { cwd?: string; env?: Record<string, string | undefined> }): Promise<SandboxExecResult>;
    readFile(path: string): Promise<{ content: string }>;
    writeFile(path: string, content: string): Promise<{ success: boolean }>;
    exists(path: string): Promise<{ exists: boolean }>;
    mountBucket(
      bucket: string,
      mountPath: string,
      options: {
        endpoint: string;
        provider?: "r2" | "s3" | "gcs";
        credentials?: { accessKeyId: string; secretAccessKey: string };
        readOnly?: boolean;
        prefix?: string;
      },
    ): Promise<void>;
  }

  export function getSandbox(namespace: DurableObjectNamespace, id: string): SandboxClient;
  export function proxyToSandbox(request: Request, env: unknown): Promise<Response | null>;
}
