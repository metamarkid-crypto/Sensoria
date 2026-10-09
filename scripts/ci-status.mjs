const TOKEN = process.argv[2] || '';
const res = await fetch('https://api.github.com/repos/metamarkid-crypto/Sensoria/actions/runs?per_page=1', {
  headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
});
const j = await res.json();
const r = (j.workflow_runs || [])[0];
console.log(r ? `${r.name} | ${r.head_sha.slice(0, 7)} | ${r.status} | ${r.conclusion}` : 'none');
