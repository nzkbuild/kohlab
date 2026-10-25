import { useEffect, useRef, useState, type PointerEvent } from "react";
import { toChat } from "../lib/toChat";
import { ArrowCounterClockwise } from "@phosphor-icons/react";
import { toast } from "sonner";
import { announce } from "../lib/announce";
import { clearStrokes, extendStroke, startStroke, strokeWidth, toImagePoint, undoStroke, type Ink, type Pt, type Size, type Stroke } from "../lib/markup";
import { cn } from "../lib/utils";
import { Button, Dialog } from "./ui";

interface Props {
  workspaceId: string;
  /** The picture to mark up, as the browser made it. Null closes the dialog. */
  image: Blob | null;
  onOpenChange: (open: boolean) => void;
}

const INKS: { ink: Ink; label: string; className: string }[] = [
  { ink: "ink-1", label: "Red pen", className: "bg-ink-1" },
  { ink: "ink-2", label: "Blue pen", className: "bg-ink-2" },
];

/** A pen colour as the canvas draws it: the token's value, read from the page. */
function inkValue(ink: Ink): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${ink}`).trim() || "CanvasText";
}

/**
 * Marks on a picture of the page. The canvas is the picture at its own size, so
 * what is drawn on it is what is sent; the screen only scales it to fit.
 */
export default function MarkupDialog({ workspaceId, image, onOpenChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bitmap = useRef<ImageBitmap | null>(null);
  const drawing = useRef(false);
  const [size, setSize] = useState<Size | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [ink, setInk] = useState<Ink>("ink-1");
  const [busy, setBusy] = useState(false);

  // Each picture starts clean: its own bitmap, no marks.
  useEffect(() => {
    if (!image) return;
    let alive = true;
    setStrokes(clearStrokes());
    createImageBitmap(image)
      .then((bmp) => {
        if (!alive) return bmp.close();
        bitmap.current = bmp;
        setSize({ width: bmp.width, height: bmp.height });
      })
      .catch(() => {
        if (alive) toast.error("Couldn't open the picture. Try again.");
      });
    return () => {
      alive = false;
      bitmap.current?.close();
      bitmap.current = null;
      setSize(null);
    };
  }, [image]);

  // Redraws the picture and every mark whenever a mark is added, undone or cleared.
  useEffect(() => {
    const canvas = canvasRef.current;
    const bmp = bitmap.current;
    if (!canvas || !bmp || !size) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = size.width;
    canvas.height = size.height;
    ctx.drawImage(bmp, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = strokeWidth(size);
    for (const s of strokes) {
      ctx.strokeStyle = inkValue(s.ink);
      ctx.fillStyle = inkValue(s.ink);
      const [first, ...rest] = s.points;
      if (!first) continue;
      if (rest.length === 0) {
        ctx.beginPath();
        ctx.arc(first.x, first.y, ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      for (const p of rest) ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
  }, [strokes, size]);

  const pointAt = (e: PointerEvent<HTMLCanvasElement>): Pt | null =>
    size ? toImagePoint({ x: e.clientX, y: e.clientY }, e.currentTarget.getBoundingClientRect(), size) : null;

  const onDown = (e: PointerEvent<HTMLCanvasElement>) => {
    const p = pointAt(e);
    if (!p) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    setStrokes((list) => startStroke(list, ink, p));
  };
  const onMove = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const p = pointAt(e);
    if (p) setStrokes((list) => extendStroke(list, p));
  };
  const onUp = () => {
    drawing.current = false;
  };

  /** Saves the picture, marks and all, as a PNG in the composer. */
  const add = async () => {
    const canvas = canvasRef.current;
    if (!canvas || !size) return;
    setBusy(true);
    try {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("The picture is empty.");
      const file = new File([blob], `page-${Date.now()}.png`, { type: "image/png" });
      toChat("kohlab:attach", { id: workspaceId, files: [file] });
      announce("Picture added to your message");
      onOpenChange(false);
    } catch (e) {
      toast.error(`Couldn't add the picture. ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={image !== null} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content dialog-wide p-4">
          <Dialog.Title className="text-base font-semibold text-text-primary">Add a picture of the page</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm leading-5 text-text-muted">
            Draw on it to show what you mean, then add it to your message.
          </Dialog.Description>

          <div className="mt-3 flex items-center justify-center overflow-hidden rounded-card bg-surface-sunken p-2">
            {size ? (
              <canvas
                ref={canvasRef}
                role="img"
                aria-label="The picture of the page. Draw on it with the mouse or your finger."
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={onUp}
                className="block h-auto max-h-[calc(100dvh-17rem)] w-auto max-w-full touch-none cursor-crosshair"
              />
            ) : (
              <p role="status" className="p-6 text-sm text-text-muted">
                Getting the picture…
              </p>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div role="group" aria-label="Pen colour" className="flex items-center gap-1">
              {INKS.map((c) => (
                <button
                  key={c.ink}
                  type="button"
                  aria-label={c.label}
                  aria-pressed={ink === c.ink}
                  title={c.label}
                  onClick={() => setInk(c.ink)}
                  className={cn("size-8 rounded-full ring-offset-2 ring-offset-surface-overlay aria-pressed:ring-2 aria-pressed:ring-focus max-md:size-11", c.className)}
                />
              ))}
            </div>
            <Button variant="quiet" size="sm" className="text-text-secondary" disabled={strokes.length === 0} onClick={() => setStrokes(undoStroke)}>
              <ArrowCounterClockwise size={16} aria-hidden="true" />
              Undo
            </Button>
            <Button variant="quiet" size="sm" className="text-text-secondary" disabled={strokes.length === 0} onClick={() => setStrokes(clearStrokes())}>
              Clear
            </Button>
          </div>

          <div className="mt-4 flex flex-col-reverse gap-2 md:flex-row md:justify-end">
            <Dialog.Close asChild>
              <Button variant="secondary" size="sm" className="max-md:w-full">
                Cancel
              </Button>
            </Dialog.Close>
            <Button variant="primary" size="sm" className="max-md:w-full" disabled={!size || busy} aria-busy={busy} onClick={() => void add()}>
              Add to message
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
