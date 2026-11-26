process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function testUserMethod(m) {
  try {
    const res = await fetch('https://onlinegolfapp.com/user/' + m, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ league: 'Te2100926', league_id: 'Te2100926' })
    });
    const text = await res.text();
    if (!text.includes('does not have a method') && !text.includes('404 Page Not Found')) {
      console.log('USER METHOD:', m, 'status:', res.status, text.substring(0, 150));
    }
  } catch(e) {}
}

async function run() {
  const actions = [
    'login', 'register', 'profile', 'league', 'leaderboard', 'draw', 'matches',
    'team', 'teams', 'score', 'scores', 'round', 'group', 'live'
  ];
  for (const a of actions) {
    await testUserMethod(a);
  }
}
run();
