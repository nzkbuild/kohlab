import { toast } from "sonner";
import { api } from "../api";

/** Run a promise with a loading→success/error toast, returning the resolved value. */
export async function withToast<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    const value = await fn();
    toast.success(`${label} done`);
    return value;
  } catch (e) {
    toast.error(`${label} failed: ${(e as Error).message}`);
    throw e;
  }
}

export function toastAction(id: string, action: string, label?: string) {
  const verb = action === "start" ? "Starting" : action === "stop" ? "Stopping" : action === "restart" ? "Restarting" : action === "delete" ? "Deleting" : "Running";
  return withToast(label ?? `${verb} ${id}`, () => api.action(id, action));
}