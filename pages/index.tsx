import { renderToString } from "preact-render-to-string";

import { html } from "utils/html.ts";
import { href, output } from "utils/path.ts";
import { write } from "utils/fs.ts";

import { Layout } from "components/Layout.tsx";
import { BlogPreviewList } from "components/BlogPreviewList.tsx";
import type { Metrics } from "./test262.tsx";

const metrics = (await (
  await fetch(
    "https://github.com/trynova/nova/raw/refs/heads/main/tests/metrics.json",
  )
).json()) as Metrics;

function Index() {
  return (
    <Layout>
      <h1>Welcome!</h1>
      <p>
        Nova is a JavaScript (<a href="https://tc39.es/ecma262/">ECMAScript</a>)
        (and in the future <a href="https://webassembly.org/">WebAssembly</a> )
        engine written in Rust and following{" "}
        <a href="https://en.wikipedia.org/wiki/Data-oriented_design">
          data-oriented design principles
        </a>
        . The engine is published on crates.io with SemVer versioning without
        particular LTS guarantees.
      </p>
      <p>
        The engine currently passes about{" "}
        <a href={href(import.meta.resolve("./test262.tsx"))}>
          {((metrics.results.pass / metrics.total) * 100).toFixed()}% of the
          Test262 test suite
        </a>
        and is considered ready for small-scale deployment. If you are
        interested in the project, please check out the{" "}
        <a href="https://github.com/trynova/nova">GitHub repository</a> and or
        join our <a href="https://trynova.zulipchat.com">Zulip chat</a> where
        the core team resides and where we discuss development.
      </p>
      <section>
        <h2>Latest Blog Posts</h2>
        <BlogPreviewList />
      </section>
    </Layout>
  );
}

if (import.meta.main) {
  await write(
    output(import.meta.url),
    html(renderToString(<Index />), {
      title: "Nova",
      description:
        "Nova is a JavaScript and WebAssembly engine written in Rust and following data-oriented design principles",
      canonical: "",
    }),
  );
}
