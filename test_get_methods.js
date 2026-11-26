process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const fs = require('fs');

async function testGet(method) {
  try {
    const url = `https://onlinegolfapp.com/thirdpartyapi/${method}?league=Te2100926&leagueid=Te2100926&teamid=7gPbK2GGeYzeuGX&round=1&roundtype=2`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Accesskey': 'AuVZzMJCcextoiS',
        'Accept': 'application/json'
      }
    });
    const text = await res.text();
    if (!text.includes('404 Page Not Found')) {
      console.log('GET HIT:', method, res.status, text.substring(0, 150));
    }
  } catch(e) {}
}

async function run() {
  const words = [
    'team_leaderboard', 'league_team_leaderboard', 'team_matches', 'league_team_matches',
    'match_leaderboard', 'league_match_leaderboard', 'matches', 'league_matches',
    'matchplay', 'league_matchplay', 'match_scores', 'league_match_scores',
    'team_scorecard', 'league_team_scorecard', 'live_score', 'league_live_score',
    'team_scores', 'league_team_scores', 'team_details', 'league_team_details',
    'draw_details', 'league_draw_details', 'match_details', 'league_match_details',
    'team_round_matches', 'league_team_round_matches', 'match_play_leaderboard',
    'club_list', 'league_club_list', 'team_list', 'league_team_list',
    'scorecard', 'league_scorecard', 'scores', 'league_scores'
  ];

  for (const w of words) {
    await testGet('ajax_get_' + w);
    await testGet('ajax_' + w);
    await testGet('get_' + w);
  }
  console.log('Done GET testing.');
}
run();
