import { Dialog } from "@/components/dialog";
import { controlClass } from "@/components/control";

type KillDialogProps = {
  killTarget: {
    type: "session" | "window";
    session: string;
    windowId?: string;
    windowCount: number;
  };
  onConfirm: () => void;
  onCancel: () => void;
};

export function KillDialog({ killTarget, onConfirm, onCancel }: KillDialogProps) {
  return (
    <Dialog
      title={killTarget.type === "window" ? "Kill tab?" : "Kill group?"}
      onClose={onCancel}
    >
      <p className="text-sm text-text-secondary mb-3">
        {killTarget.type === "window" ? (
          <>Kill this tab in <strong>{killTarget.session}</strong>?</>
        ) : (
          <>Kill group <strong>{killTarget.session}</strong> and all{" "}
          {killTarget.windowCount} tab
          {killTarget.windowCount !== 1 ? "s" : ""}?</>
        )}
      </p>
      <div className="flex gap-2">
        <button
          onClick={onCancel}
          className={`flex-1 ${controlClass({ variant: "confirm" })}`}
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          className={`flex-1 ${controlClass({ variant: "confirm", danger: true })}`}
        >
          Kill
        </button>
      </div>
    </Dialog>
  );
}
