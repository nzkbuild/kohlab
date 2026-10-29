/** The menu on each chat message. */
import { DotsThree } from "@phosphor-icons/react";
import { cn } from "../../lib/utils";
import { Button, Menu, MenuItem } from "../ui";

/** The ⋯ under a message: copy it, and the actions that need a checkpoint or the newest message (each passed only when it applies). Quiet: shown on hover or focus, always on touch. */
export function MessageMenu({
  onCopy,
  onEdit,
  onChanges,
  onBack,
  onBranch,
}: {
  onCopy: () => void;
  onEdit?: () => void;
  onChanges?: () => void;
  onBack?: () => void;
  onBranch?: () => void;
}) {
  return (
    <div className="-mt-1 flex h-6 items-center justify-end">
      <Menu
        align="end"
        label="Message actions"
        trigger={
          <Button
            variant="quiet"
            size="sm"
            iconOnly
            aria-label="Message actions"
            className={cn(
              "text-text-faint hover:text-text-primary data-[state=open]:opacity-100 [@media(pointer:coarse)]:opacity-100",
              "motion-safe:transition-opacity opacity-0 group-focus-within/msg:opacity-100 group-hover/msg:opacity-100",
            )}
          >
            <DotsThree size={16} aria-hidden="true" />
          </Button>
        }
      >
        <MenuItem onSelect={onCopy}>Copy message</MenuItem>
        {onEdit ? <MenuItem onSelect={onEdit}>Edit and resend</MenuItem> : null}
        {onChanges ? <MenuItem onSelect={onChanges}>What this changed</MenuItem> : null}
        {onBack ? <MenuItem onSelect={onBack}>Go back to here</MenuItem> : null}
        {onBranch ? <MenuItem onSelect={onBranch}>New chat from here</MenuItem> : null}
      </Menu>
    </div>
  );
}
