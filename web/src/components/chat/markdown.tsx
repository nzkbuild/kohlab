/** Chat markdown: inline and block rendering. */
import { type ReactNode } from "react";
import { inline, parseBlocks, type Inline } from "../../lib/markdown";
import { cn } from "../../lib/utils";
import { CodeBlock } from "./copy";
import { HtmlFrame, ProjectImage } from "./media";

/** Inline pieces as elements, never as HTML: bold, `code`, links. Anything else stays plain text. */
function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.kind) {
      case "text":
        return node.text;
      case "strong":
        return <strong key={i}>{renderInline(node.children)}</strong>;
      case "em":
        return <em key={i}>{renderInline(node.children)}</em>;
      case "del":
        return <del key={i}>{renderInline(node.children)}</del>;
      case "code":
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

/** The indent of a nested list item, by its level (0 = top). */
const NEST = ["", "ml-5", "ml-10", "ml-15"];

/** What Claude said, in a measure a person can read without losing their place. A finished html or mermaid block is drawn, unless the reply is still streaming. */
export function Prose({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="flex max-w-[66ch] min-w-0 flex-col gap-3 text-base leading-6 text-text-primary max-md:max-w-none max-md:w-full max-md:text-base">
      {parseBlocks(text).map((block, i) => {
        if (block.kind === "p") return <p key={i} className="whitespace-pre-line">{rich(block.lines.join("\n"))}</p>;
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
