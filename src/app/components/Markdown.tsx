// Markdown for agent-authored chat text. Entity links use the markdown link
// syntax with a `type:id` href ([my words](todo:12)) and route internally;
// real URLs open in a new tab. HTML is escaped by react-markdown's default.
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import { Link } from "react-router-dom";
import { shortUrl } from "../refs";

const ENTITY = /^(todo|project|log):(\d+)$/;
const BASES: Record<string, string> = { todo: "todos", project: "projects", log: "logs" };

/** Legacy bare tokens ([todo:12]) become minimal links before parsing; bare
 * URLs the agent copied into filed text become CommonMark autolinks (skip
 * ones already inside a markdown link/autolink; trailing punctuation stays
 * text). */
function preprocess(text: string): string {
  return text
    .replace(/(^|[^\]])\[(todo|project|log):(\d+)\]/g, "$1[#$3]($2:$3)")
    .replace(/(?<![(<])(https?:\/\/[^\s<>()"']+)/g, (m) => {
      const url = m.replace(/[.,;:!?]+$/, "");
      return `<${url}>${m.slice(url.length)}`;
    });
}

export default function Markdown(props: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        // react-markdown's sanitizer drops unknown protocols, turning
        // todo:12 hrefs into "" (which navigates to the current page).
        urlTransform={(u) => (ENTITY.test(u) ? u : defaultUrlTransform(u))}
        components={{
          a: ({ href, children }) => {
            // Cards navigate on click — a link inside one must not also
            // trigger the card's navigation.
            const stop = (e: React.MouseEvent) => e.stopPropagation();
            const m = (href ?? "").match(ENTITY);
            if (m) {
              return (
                <Link className="brief-ref" to={`/${BASES[m[1]]}/${m[2]}`} onClick={stop}>
                  {children}
                </Link>
              );
            }
            // In-app links (relative paths or our own origin) navigate in
            // place; only genuinely external URLs open a new tab.
            const h = href ?? "";
            if (h.startsWith("/")) {
              return (
                <Link className="brief-ref" to={h} onClick={stop}>
                  {children}
                </Link>
              );
            }
            try {
              const u = new URL(h);
              if (u.origin === window.location.origin) {
                return (
                  <Link className="brief-ref" to={u.pathname + u.search + u.hash} onClick={stop}>
                    {children}
                  </Link>
                );
              }
            } catch {
              /* not a URL — fall through */
            }
            // The model sometimes emits a link with no usable target ("[]()"
            // or a malformed entity ref the sanitizer blanked) — render the
            // words, not a dead new-tab anchor.
            if (!h) return <>{children}</>;
            // Autolinked bare URLs (label === target) display in short form.
            const label = Array.isArray(children) && children.length === 1 ? children[0] : children;
            return (
              <a href={href} target="_blank" rel="noreferrer" onClick={stop}>
                {typeof label === "string" && label === h ? shortUrl(h) : children}
              </a>
            );
          },
        }}
      >
        {preprocess(props.text)}
      </ReactMarkdown>
    </div>
  );
}
