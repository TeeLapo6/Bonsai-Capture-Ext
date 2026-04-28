const fs = require('fs');
const map = JSON.parse(fs.readFileSync('dist/content/chatgpt.js.map', 'utf8'));
const idx = map.sources.findIndex((s) => s.includes('chatgpt.ts'));
if (idx !== -1 && map.sourcesContent[idx]) {
    fs.writeFileSync('/tmp/chatgpt_recovered.ts', map.sourcesContent[idx]);
    console.log('Recovered', map.sourcesContent[idx].split('\n').length, 'lines');
} else {
    console.log('Not found');
}
