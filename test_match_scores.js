const fs = require('fs');
const { morningScheduleRound2Day1 } = require('./official_draw_schedule.js');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const ACCESS_KEY = "AuVZzMJCcextoiS";
const LEAGUE_ID = "Te2100926";

const teamIds = [
  'P1Xhj2jEmbBdIFD', // PROMAN CRUSHERS
  'uBHR5G4ArbC5Jk2', // CONFIDENT PAR -TEE
  '3VFXuJNSMRikSb7', // ATTIKAN ARCHERS
  'FNMtniVKnDjuFAA', // ADARSH ACES
  'iY0RU5lUSBJHn1r'  // PROMAC PINHIGH
];

function cleanStr(n) {
  return (n || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

async function run() {
  const allMatchesFromApi = [];
  const results = await Promise.all(teamIds.map(id => 
    fetch('https://onlinegolfapp.com/thirdpartyapi/ajax_get_league_leaderboardpoints', {
      method: 'POST',
      headers: { 'Accesskey': ACCESS_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ league: LEAGUE_ID, rtype: '2', teamid: id })
    }).then(r => r.json()).catch(e => {
      console.error('Fetch err for', id, e.message);
      return null;
    })
  ));

  results.forEach(d => {
    const rp = d && d.data && d.data.scores && d.data.scores[0] && d.data.scores[0].roundpoints;
    if (rp && rp.R2_playernames) {
      allMatchesFromApi.push(...rp.R2_playernames);
    }
  });

  console.log('Total API match records collected:', allMatchesFromApi.length);

  morningScheduleRound2Day1.forEach(m => {
    const t1 = cleanStr(m.team1.name);
    const t2 = cleanStr(m.team2.name);
    const mHole = String(m.hole || '').replace(/[^0-9]/g, '');
    const mTime = cleanStr(m.time);
    const mCat = cleanStr(m.bonusTag);

    // Find in allMatchesFromApi
    const found = allMatchesFromApi.find(apiM => {
      const a1 = cleanStr(apiM.team1);
      const a2 = cleanStr(apiM.team2);
      const teamsMatch = (a1 === t1 && a2 === t2) || (a1 === t2 && a2 === t1);
      if (!teamsMatch) return false;

      const drw = apiM.drw1 && apiM.drw1[0];
      const aHole = String(drw ? drw.ldr_hole : '').trim();
      const aTime = cleanStr(drw ? drw.ldr_slot_time : '');
      const aCat = cleanStr(apiM.category_label);
      const aSession = String(drw ? drw.crw_session : '');

      // Check session (1 = morning)
      if (aSession && aSession !== '1') return false;

      // Check category or time
      if (mCat && aCat && mCat === aCat) return true;
      if (mTime && aTime && mTime.slice(0, 4) === aTime.slice(0, 4) && (!mHole || !aHole || mHole === aHole)) return true;
      return false;
    });

    if (found) {
      const isDirect = cleanStr(found.team1) === t1;
      const t1Cur = isDirect ? found.team1_current : found.team2_current;
      const t2Cur = isDirect ? found.team2_current : found.team1_current;
      const finHoles = found.drw1 && found.drw1[0] ? found.drw1[0].FinishedHoles : '0';
      console.log(`[MATCH ${m.matchNum}] ${m.time} | ${m.hole} | ${m.team1.name} vs ${m.team2.name} | Cat: ${m.bonusTag} -> T1: '${t1Cur}' | T2: '${t2Cur}' | Fin: ${finHoles}`);
    } else {
      console.log(`[MATCH ${m.matchNum}] ${m.time} | ${m.hole} | ${m.team1.name} vs ${m.team2.name} -> NOT FOUND`);
    }
  });
}

run();
