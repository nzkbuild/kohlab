/** Chat markdown: inline and block rendering. */
import { type ReactNode, useState } from "react";
import { inline, parseBlocks, type Inline } from "../../lib/markdown";
import { cn } from "../../lib/utils";
import { CodeBlock } from "./copy";
import { HtmlFrame, ProjectImage } from "./media";
import { FileCard, PathChip, chipPath } from "./FileCard";

/** The path chips of a paragraph: which are open, and how to flip one. */
type Chips = { open: (path: string) => boolean; toggle: (path: string) => void };

/** Inline pieces as elements, never as HTML: bold, `code`, links. Anything else stays plain text. In a paragraph, a code span that is a file becomes a path chip. */
function renderInline(nodes: Inline[], chips?: Chips): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.kind) {
      case "text":
        return node.text;
      case "strong":
        return <strong key={i}>{renderInline(node.children, chips)}</strong>;
      case "em":
        return <em key={i}>{renderInline(node.children, chips)}</em>;
      case "del":
        return <del key={i}>{renderInline(node.children, chips)}</del>;
      case "code":
        if (chips && chipPath(node.text))
          return <PathChip key={i} path={node.text} open={chips.open(node.text)} onToggle={() => chips.toggle(node.text)} />;
        return (
          <code key={i} className="mono rounded bg-surface-sunken px-1 py-0.5 text-[0.85em]">
            {node.text}
          </code>
        );
      case "link":
        return (
          <a
            key={i}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-text-primary underline decoration-line-strong underline-offset-[3px] hover:decoration-line-accent"
          >
            {node.text}
          </a>
        );
      case "image":
        return <ProjectImage key={i} path={node.src} alt={node.alt} />;
    }
  });
}

const rich = (text: string) => renderInline(inline(text));

/** A paragraph. Its path chips open the files' cards below it, one card per chip that is open. */
function Paragraph({ text }: { text: string }) {
  const [shown, setShown] = useState<string[]>([]);
  const chips: Chips = {
    open: (path) => shown.includes(path),
    toggle: (path) => setShown((s) => (s.includes(path) ? s.filter((p) => p !== path) : [...s, path])),
  };
  return (
    <>
      <p className="whitespace-pre-line">{renderInline(inline(text), chips)}</p>
      {shown.map((path) => (
        <FileCard key={path} path={path} startOpen />
      ))}
    </>
  );
}

/** The indent of a nested list item, by its level (0 = top). */
const NEST = ["", "ml-5", "ml-10", "ml-15"];

/** What Claude said, in a measure a person can read without losing their place. A finished html or mermaid block is drawn, unless the reply is still streaming. */
export function Prose({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="flex max-w-[66ch] min-w-0 flex-col gap-3 text-base leading-6 text-text-primary max-md:max-w-none max-md:w-full max-md:text-base">
      {parseBlocks(text).map((block, i) => {
        if (block.kind === "p") return <Paragraph key={i} text={block.lines.join("\n")} />;
        if (block.kind === "h") return <p key={i} className="text-xl font-semibold text-text-primary">{rich(block.text)}</p>;
        if (block.kind === "subh") return <p key={i} className="text-lg font-semibold text-text-primary">{rich(block.text)}</p>;
        if (block.kind === "quote") {
          // A fill bar, not a border: the quote is muted text beside a tonal bar.
          return (
            <div key={i} className="flex min-w-0 gap-3">
              <span aria-hidden="true" className="w-[3px] shrink-0 rounded-full bg-surface-active" />
              <p className="min-w-0 text-text-muted whitespace-pre-line">{rich(block.lines.join("\n"))}</p>
            </div>
          );
        }
        if (block.kind === "hr") return <hr key={i} className="border-line-subtle" />;
        if (block.kind === "code") {
          const lang = block.lang.toLowerCase();
          if (!streaming && (lang === "html" || lang === "mermaid")) return <HtmlFrame key={i} kind={lang} code={block.code} />;
          return <CodeBlock key={i} lang={block.lang} code={block.code} />;
        }
        if (block.kind === "table") {
          return (
            <div key={i} className="overflow-x-auto rounded-card bg-surface-sunken">
              <table className="w-full border-collapse text-sm leading-5">
                <thead>
                  <tr>
                    {block.head.map((c, j) => (
                      <th key={j} scope="col" className="min-w-[8ch] px-3.5 py-2 text-left align-bottom font-semibold text-text-primary">
                        {rich(c)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((r, k) => (
                    <tr key={k} className="border-t border-line-subtle">
                      {r.map((c, j) => (
                        <td key={j} className="min-w-[8ch] px-3.5 py-2 align-top text-text-primary">
                          {rich(c)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        // Each nested level indents the item by one step (two levels and up share the last step).
        if (block.kind === "ul") {
          return (
            <ul key={i} className="space-y-2">
              {block.items.map((item, j) => (
                <li
                  key={j}
                  className={cn(
                    "relative pl-[18px] before:absolute before:top-[10px] before:left-[4px] before:size-[5px] before:rounded-full before:bg-text-muted before:content-['']",
                    NEST[Math.min(block.levels?.[j] ?? 0, NEST.length - 1)],
                  )}
                >
                  {rich(item)}
                </li>
              ))}
            </ul>
          );
        }
        return (
          <ol key={i} className="list-decimal space-y-2 pl-[18px] marker:text-text-muted">
            {block.items.map((item, j) => (
              <li key={j} className={NEST[Math.min(block.levels?.[j] ?? 0, NEST.length - 1)]}>
                {rich(item)}
              </li>
            ))}
          </ol>
        );
      })}
    </div>
  );
}
