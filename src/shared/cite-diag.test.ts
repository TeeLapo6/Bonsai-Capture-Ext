import { describe, it, expect } from "vitest";
import { renderConversationGraphToHtml } from "./render-preview-html";

describe("HTML citation path", () => {
    it("renders lenticular bracket citations as sequential sup", () => {
        const open = "【";
        const close = "】";
        const dagger = "†";
        const graph: any = {
            conversation_id: "test", title: "T",
            source: { provider_site: "chatgpt.com", url: "u", captured_at: "2026-01-01T00:00:00.000Z", capture_version: "0.1.0" },
            provenance: { provider: "openai", confidence: "observed" },
            messages: [{ message_id: "m1", role: "assistant", sequence: 0, origin: { provider: "openai", confidence: "observed" }, content_blocks: [], artifact_ids: ["a1"], deep_link: { url: "u" } }],
            artifacts: [{
                artifact_id: "a1", type: "deep_research", title: "R", mime_type: "text/html",
                content: [
                    "<p>Text " + open + "25" + dagger + "L1-L5" + close + " and " + open + "17" + dagger + "L6-L10" + close + ".</p>",
                    "<section data-bonsai-sources=\"true\">",
                    "<h2>S</h2>",
                    "<ul>",
                    "  <li data-bonsai-source-index=\"17\"><sup>17</sup> <a href=\"https://a.com\">A</a></li>",
                    "  <li data-bonsai-source-index=\"25\"><sup>25</sup> <a href=\"https://b.com\">B</a></li>",
                    "</ul>",
                    "</section>",
                ].join("\n"),
                source_message_id: "m1", exportable: true
            }]
        };
        const html = renderConversationGraphToHtml(graph);
        const idx = html.indexOf("Text ");
        console.log("snippet:", html.substring(idx, idx + 400));
        expect(html).toContain("bonsai-citation");
        // Source anchors should be on the <li> so TipTap listItem node preserves them.
        expect(html).toContain('id="artifact-a1-source-17"');
        expect(html).toContain('id="artifact-a1-source-25"');
    });

    it("renders adjacent multi-index bracket citations as separate linked sups", () => {
        const graph: any = {
            conversation_id: "test2", title: "T2",
            source: { provider_site: "chatgpt.com", url: "u", captured_at: "2026-01-01T00:00:00.000Z", capture_version: "0.1.0" },
            provenance: { provider: "openai", confidence: "observed" },
            messages: [{ message_id: "m1", role: "assistant", sequence: 0, origin: { provider: "openai", confidence: "observed" }, content_blocks: [], artifact_ids: ["a2"], deep_link: { url: "u" } }],
            artifacts: [{
                artifact_id: "a2", type: "deep_research", title: "R2", mime_type: "text/html",
                content: [
                    // [4,5] combined-bracket citation and adjacent separate brackets [6][7]
                    "<p>Combined [4,5\u2020hint] and separate [6][7].</p>",
                    "<section data-bonsai-sources=\"true\">",
                    "<h2>S</h2>",
                    "<ul>",
                    "  <li data-bonsai-source-index=\"4\"><sup>4</sup> <a href=\"https://d.com\">D</a></li>",
                    "  <li data-bonsai-source-index=\"5\"><sup>5</sup> <a href=\"https://e.com\">E</a></li>",
                    "  <li data-bonsai-source-index=\"6\"><sup>6</sup> <a href=\"https://f.com\">F</a></li>",
                    "  <li data-bonsai-source-index=\"7\"><sup>7</sup> <a href=\"https://g.com\">G</a></li>",
                    "</ul>",
                    "</section>",
                ].join("\n"),
                source_message_id: "m1", exportable: true
            }]
        };
        const html = renderConversationGraphToHtml(graph);
        // [4,5†hint] should expand to TWO linked sups joined by a comma (e.g. 3, 4).
        expect(html).toContain('href="#artifact-a2-source-4"');
        expect(html).toContain('>, <');
        expect(html).toContain('href="#artifact-a2-source-5"');
        expect(html).toContain('href="#artifact-a2-source-6"');
        expect(html).toContain('href="#artifact-a2-source-7"');
        // Source anchors are on <li> elements (navigable by TipTap listItem).
        expect(html).toContain('id="artifact-a2-source-4"');
        expect(html).toContain('id="artifact-a2-source-5"');
    });

    it("rewrites bare HTML <sup> citations from ChatGPT deep research iframe", () => {
        const graph: any = {
            conversation_id: "test3", title: "T3",
            source: { provider_site: "chatgpt.com", url: "u", captured_at: "2026-01-01T00:00:00.000Z", capture_version: "0.1.0" },
            provenance: { provider: "openai", confidence: "observed" },
            messages: [{ message_id: "m1", role: "assistant", sequence: 0, origin: { provider: "openai", confidence: "observed" }, content_blocks: [], artifact_ids: ["a3"], deep_link: { url: "u" } }],
            artifacts: [{
                artifact_id: "a3", type: "deep_research", title: "R3", mime_type: "text/html",
                content: [
                    // ChatGPT renders citations as bare <sup>N</sup> or <sup><a href="#ref-N">N</a></sup>
                    "<p>Growth forecast<sup><a href=\"#ref-4\">4</a></sup><sup><a href=\"#ref-5\">5</a></sup> with details<sup>10</sup>.</p>",
                    "<section data-bonsai-sources=\"true\">",
                    "<h2>Sources</h2>",
                    "<ul>",
                    "  <li data-bonsai-source-index=\"4\"><sup>4</sup> <a href=\"https://src-d.com\">Source D</a></li>",
                    "  <li data-bonsai-source-index=\"5\"><sup>5</sup> <a href=\"https://src-e.com\">Source E</a></li>",
                    "  <li data-bonsai-source-index=\"10\"><sup>10</sup> <a href=\"https://src-j.com\">Source J</a></li>",
                    "</ul>",
                    "</section>",
                ].join("\n"),
                source_message_id: "m1", exportable: true
            }]
        };
        const html = renderConversationGraphToHtml(graph);
        // Adjacent HTML citations <sup><a>4</a></sup><sup><a>5</a></sup> should become linked bonsai-citations, separated by a comma
        expect(html).toContain('class="bonsai-citation"');
        expect(html).toContain('href="#artifact-a3-source-4"');
        expect(html).toContain('>, <');
        expect(html).toContain('href="#artifact-a3-source-5"');
        expect(html).toContain('href="#artifact-a3-source-10"');
        // Original internal ChatGPT anchors (#ref-4, #ref-5) should be replaced.
        expect(html).not.toContain('href="#ref-4"');
        expect(html).not.toContain('href="#ref-5"');
        // Source anchors should exist.
        expect(html).toContain('id="artifact-a3-source-4"');
        expect(html).toContain('id="artifact-a3-source-5"');
        expect(html).toContain('id="artifact-a3-source-10"');
    });
    it("reproduces the user's exact probe content format", () => {
        const graph: any = {
            conversation_id: "test-user", title: "T3",
            provenance: { provider: "openai", confidence: "observed" },
            source: { provider_site: "chatgpt.com", url: "https://chatgpt.com", captured_at: "2026-01-01T00:00:00.000Z" },
            messages: [{ message_id: "m1", role: "assistant", sequence: 0, origin: { provider: "openai" }, content_blocks: [], artifact_ids: ["a-user"], deep_link: { url: "u" } }],
            artifacts: [{
                artifact_id: "a-user", type: "deep_research", title: "R3", mime_type: "text/markdown",
                content: `Here is the data o nearly double to ~$195 B by 2031 (≈12% CAGR)【1†L111-L116】.  The enterprise collaboration segment ~13% CAGR)【17†L114-L122】, while dedicated knowled
                
<section data-bonsai-sources="true">
<h2>Sources</h2>
<ul>
  <li data-bonsai-source-index="1"><sup>1</sup> <a href="https://example.com/1">Source 1</a></li>
  <li data-bonsai-source-index="17"><sup>17</sup> <a href="https://example.com/17">Source 17</a></li>
</ul>
</section>`,
                source_message_id: "m1", exportable: true
            }]
        };
        const html = renderConversationGraphToHtml(graph);
        const idx = html.indexOf("(≈12% CAGR)");
        console.log("USER BUG HTML:", html.substring(idx - 20, idx + 200));
        // It SHOULD rewrite 【1†...】 to 1, and 【17†...】 to 2
        // Since we reverted the sequential counter, it should deduplicate.
        expect(html).toContain('>1</a></sup>');
        expect(html).toContain('>2</a></sup>');
        expect(html).not.toContain('【1†L111-L116】');
    });
});
