import { RunCancelledError } from "../../loop/run";

export function isRunCancelledError(error: unknown): error is RunCancelledError {
  return error instanceof RunCancelledError;
}
