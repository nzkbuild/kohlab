/** Copy buttons and code blocks in the chat. */
import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "@phosphor-icons/react";
import { toast } from "sonner";
import { announce } from "../../lib/announce";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/utils";
import { Button, Tooltip } from "../ui";

/** Copy with a check mark for 1.5 s. A failed copy says so. */
export function useCopied(): [boolean, (text: string) => Promise<void>] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async (text: string) => {
    try {
      await copyText(text);
      setCopied(true);
      announce("Copied");
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy");
    }
  };
  return [copied, copy];
}

/** The action row under a reply. Hidden until the reply is hovered or focused; always shown on touch and on the latest reply. */
export function CopyReply({ text, latest }: { text: string; latest: boolean }) {
  const [copied, copy] = useCopied();
  const Icon = copied ? Check : Copy;
  return (
    <div className="-ml-2.5 -mt-1 flex">
      <Tooltip content="Copy">
        <Button
          variant="quiet"
          iconOnly
          aria-label="Copy reply"
          className={cn(
            "text-text-faint hover:text-text-primary [@media(pointer:coarse)]:opacity-100",
            "motion-safe:transition-opacity",
            latest ? "opacity-100" : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100",
          )}
          onClick={() => void copy(text)}
        >
          <Icon size={16} aria-hidden="true" />
        </Button>
      </Tooltip>
    </div>
  );
}

/** A fenced block: mono code that scrolls sideways, with its language and a Copy of the code only. */
export function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, copy] = useCopied();
  const Icon = copied ? Check : Copy;
  return (
    <div className="overflow-hidden rounded-card bg-surface-sunken">
      <div className="flex items-center justify-between gap-3 py-0.5 pr-1 pl-3.5">
        <span className="mono min-w-0 truncate text-xs text-text-muted">{lang}</span>
        <Button
          variant="quiet"
          size="sm"
          aria-label="Copy code"
          className="text-xs text-text-secondary"
          onClick={() => void copy(code)}
        >
          <Icon size={14} aria-hidden="true" />
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="mono overflow-x-auto px-3.5 py-3 text-sm leading-5 text-text-primary">
        <code>{code}</code>
      </pre>
    </div>
  );
}
