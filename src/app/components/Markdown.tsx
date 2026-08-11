// Markdown for agent-authored chat text. Entity links use the markdown link
// syntax with a `type:id` href ([my words](todo:12)) and route internally;
// real URLs open in a new tab. HTML is escaped by react-markdown's default.
import ReactMarkdown from "react-markdown";
import { Link } from "react-router-dom";

const ENTITY = /^(todo|project|log):(\d+)$/;
const BASES: Record<string, string> = { todo: "todos", project: "projects", log: "logs" };

/** Legacy bare tokens ([todo:12]) become minimal links before parsing. */
function preprocess(text: string): string {
  return text.replace(/(^|[^\]])\[(todo|project|log):(\d+)\]/g, "$1[#$3]($2:$3)");
}

export default function Markdown(props: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        components={{
          a: ({ href, children }) => {
            const m = (href ?? "").match(ENTITY);
            if (m) {
              return (
                <Link className="brief-ref" to={`/${BASES[m[1]]}/${m[2]}`}>
                  {children}
                </Link>
              );
            }
            // In-app links (relative paths or our own origin) navigate in
            // place; only genuinely external URLs open a new tab.
            const h = href ?? "";
            if (h.startsWith("/")) {
              return (
                <Link className="brief-ref" to={h}>
                  {children}
                </Link>
              );
            }
            try {
              const u = new URL(h);
              if (u.origin === window.location.origin) {
                return (
                  <Link className="brief-ref" to={u.pathname + u.search + u.hash}>
                    {children}
                  </Link>
                );
              }
            } catch {
              /* not a URL — fall through */
            }
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
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
