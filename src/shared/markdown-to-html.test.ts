import { describe, expect, it } from 'vitest';

import { markdownToHtml } from './markdown-to-html';

describe('markdownToHtml', () => {
  it('renders tables into semantic HTML', () => {
    const html = markdownToHtml(`Title\n\n| Name | Value |\n| --- | --- |\n| A | 1 |`);

    expect(html).toContain('<table>');
    expect(html).toContain('<th>Name</th>');
    expect(html).toContain('<td>A</td>');
  });

  it('renders fenced code blocks with preserved code tags', () => {
    const html = markdownToHtml('```ts\nconst value = 1;\n```');

    expect(html).toContain('<pre><code class="language-ts">');
    expect(html).toContain('const value = 1;');
  });

  it('renders mermaid fences as language-tagged code blocks', () => {
    const html = markdownToHtml('```mermaid\nflowchart TD\n  A --> B\n```');

    expect(html).toContain('<pre><code class="language-mermaid">');
    expect(html).toContain('flowchart TD');
  });
});