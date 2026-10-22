import { LoaderCircle } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import type { TaskRequest } from "@/app/_components/dashboard/types";

export function TaskReview({
  task,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  task: TaskRequest | null;
  pending: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog
      open={!!task}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <AlertDialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>{task?.title}</AlertDialogTitle>
          <AlertDialogDescription>
            Review the scope and work below before starting this task.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <dl className="detail-fields">
          <div>
            <dt>Scope</dt>
            <dd>{task?.scope}</dd>
          </div>
          <div>
            <dt>What happens</dt>
            <dd>{task?.effect}</dd>
          </div>
        </dl>
        <p className="text-sm text-muted-foreground" role="status">
          {pending
            ? "Preparing your request. Keep this page open until it is accepted."
            : "Large scopes can take time to prepare. Once accepted, the task runs in the background. Follow progress in Data updates."}
        </p>
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Request needs attention</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {pending && (
              <LoaderCircle className="animate-spin" data-icon="inline-start" />
            )}
            {pending ? "Preparing task…" : task?.submitLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
