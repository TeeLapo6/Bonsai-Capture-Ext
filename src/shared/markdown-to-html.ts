import { marked } from 'marked';

export function markdownToHtml(markdown: string): string {
    if (!markdown.trim()) {
        return '';
    }

    const rendered = marked.parse(markdown, {
        async: false,
        breaks: true,
        gfm: true,
    });

    return String(rendered).replace(/<a href="([^"]+)"/g, (match, href: string) => {
        if (href.startsWith('#')) {
            return match;
        }

        return `<a href="${href}" target="_blank" rel="noreferrer"`;
    });
}
