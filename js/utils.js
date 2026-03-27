// Room codes use unambiguous characters (no 0/O, 1/I/L)
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRoomCode() {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
  }
  return code;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Starting team gets 9 words, other gets 8, 7 bystanders, 1 assassin = 25
function generateKeyCard(startingTeam) {
  const other = startingTeam === 'red' ? 'blue' : 'red';
  return shuffle([
    ...Array(9).fill(startingTeam),
    ...Array(8).fill(other),
    ...Array(7).fill('bystander'),
    'assassin'
  ]);
}

function pickWords(wordList) {
  return shuffle(wordList).slice(0, 25);
}

function opposite(team) {
  return team === 'red' ? 'blue' : 'red';
}

function teamLabel(team) {
  return team === 'red' ? 'RED' : 'BLUE';
}

function copyText(text) {
  if (navigator.clipboard) return navigator.clipboard.writeText(text);
  const el = document.createElement('textarea');
  el.value = text;
  Object.assign(el.style, { position: 'fixed', opacity: 0 });
  document.body.appendChild(el);
  el.select();
  document.execCommand('copy');
  document.body.removeChild(el);
  return Promise.resolve();
}
