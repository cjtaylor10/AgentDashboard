// Add an idea to the Chair's inbox. The council pulls from here when it has no other work.
// Usage: node scripts/add-idea.js "your idea text"
import { openDb, addIdea, listIdeas } from '../src/db.js';

const text = process.argv.slice(2).join(' ').trim();
const db = openDb();
if (!text) {
  const ideas = listIdeas(db);
  console.log(`${ideas.length} idea(s) in the inbox:`);
  for (const i of ideas) console.log(`  [${i.status}] ${i.id}  ${i.text}`);
} else {
  const id = addIdea(db, { text });
  console.log('added', id, '—', text);
}
db.close();
