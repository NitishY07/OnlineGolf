const { morningSchedule, afternoonSchedule, allOfficialMatches, morningScheduleDay2, afternoonScheduleDay2, allDay2Matches, morningScheduleRound2Day1, afternoonScheduleRound2Day1, allRound2Day1Matches } = require('./official_draw_schedule.js');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const PORT = process.env.PORT || 9000;
const ACCESS_KEY = process.env.ACCESS_KEY || "AuVZzMJCcextoiS";
const LEAGUE_ID = process.env.LEAGUE_ID || "Te2100926";
const ROUND_TYPE = process.env.ROUND_TYPE || "2";
const BASE_URL = "https://onlinegolfapp.com/thirdpartyapi";

let selectedTeam1 = null;
let selectedTeam2 = null;
let selectedHole = 'HOLE MATCHUP';
let selectedMatchStatus = 'ALL SQUARE';   // e.g. "1 UP", "ALL SQUARE", "2 DN"
let selectedPlayers1 = [];               // manual override (comma-separated from control panel)
let selectedPlayers2 = [];
let selectedDrawDate = '2026-11-27';     // filter draws to Round 2 Day 1 (Friday, 27 Nov)
let selectedDrawSession = 'all';         // 'all', 'morning', or 'afternoon'
let selectedDrawMatchId = null;          // null = auto-cycle, or 'M1', 'M2', 'A1', etc. to hold a specific match!

const SCORES_FILE = path.join(__dirname, 'manual_match_scores.json');
let manualMatchScores = {};
try {
  if (fs.existsSync(SCORES_FILE)) {
    manualMatchScores = JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8'));
  }
} catch(e) {
  manualMatchScores = {};
}

function saveManualScores() {
  try {
    fs.writeFileSync(SCORES_FILE, JSON.stringify(manualMatchScores, null, 2), 'utf8');
  } catch(e) {
    console.error('Failed to save manual scores:', e);
  }
}

// ── Player cache: teamid → [player names] fetched from individual leaderboard ──
let playerCache = {};   // { teamid: ['Name1', 'Name2', ...] }
let playerCacheTime = 0;
const CACHE_TTL_MS = 60 * 1000; // refresh every 60s

async function refreshPlayerCache() {
  try {
    const data = await postJson('/ajax_get_league_individual_leaderboard', {
      league: LEAGUE_ID, round: ROUND_TYPE, roundtype: ROUND_TYPE
    });
    if (!data || data.status !== 1 || !data.data || !data.data.allscores) return;
    const map = {};
    for (const player of data.data.allscores) {
      if (!player.teamid) continue;
      if (!map[player.teamid]) map[player.teamid] = [];
      const name = (player.glfname || '').trim();
      if (name) map[player.teamid].push(name);
    }
    playerCache = map;
    playerCacheTime = Date.now();
    console.log(`✅ Player cache refreshed — ${Object.keys(map).length} teams, ${data.data.allscores.length} players`);
  } catch (err) {
    console.log('⚠️  Player cache refresh error:', err.message);
  }
}

async function getPlayersForTeam(teamid) {
  if (Date.now() - playerCacheTime > CACHE_TTL_MS) {
    await refreshPlayerCache();
  }
  return playerCache[teamid] || [];
}

// ------------------- POST FUNCTION -------------------
async function postJson(endpoint, body){
  try {
    const res = await fetch(`${BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accesskey': ACCESS_KEY,
        'Accept': 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(6000)
    });

    const text = await res.text();
    return JSON.parse(text);
  } catch {
    return { status: 0 };
  }
}

// ------------------- HELPER TO EXTRACT TEAMS SAFELY -------------------
function extractTeams(data){
  if(!data || !data.data) return [];

  return (
    data.data.allscores ||
    data.data.leaderboard ||
    data.data.teamlist ||
    data.data.teams ||
    []
  );
}

// ------------------- ROUTES -------------------

app.get('/', (req, res) => {
  res.redirect('/control');
});

app.get('/control', (req,res)=>{
  res.sendFile(path.join(__dirname,'public','control.html'));
});

app.get('/team-overlay', (req,res)=>{
  res.sendFile(path.join(__dirname,'public','team-overlay.html'));
});

app.get('/team-standings-full', (req,res)=>{
  res.sendFile(path.join(__dirname,'public','team-standings-full.html'));
});

app.get('/team-standings-live', (req,res)=>{
  res.sendFile(path.join(__dirname,'public','team-standings-live.html'));
});

app.get('/team-standings-table', (req,res)=>{
  res.sendFile(path.join(__dirname,'public','team-standings-live.html'));
});

app.get('/group-standings-full', (req,res)=>{
  res.sendFile(path.join(__dirname,'public','group-standings-full.html'));
});

app.get('/group-standings-live', (req,res)=>{
  res.sendFile(path.join(__dirname,'public','group-standings-live.html'));
});

app.get('/draw', (req,res)=>{
  res.sendFile(path.join(__dirname,'public','draw-full.html'));
});

app.get('/draw-full', (req,res)=>{
  res.sendFile(path.join(__dirname,'public','draw-full.html'));
});

app.get('/draw-live', (req,res)=>{
  res.sendFile(path.join(__dirname,'public','draw-live.html'));
});

app.get('/draw-stacked', (req,res)=>{
  res.sendFile(path.join(__dirname,'public','draw-stacked.html'));
});

// 🔥 GET GROUP-WISE STANDINGS (merged with live overall points)
app.get('/api/group-standings', async (req,res)=>{
  try{
    // Fetch both in parallel
    const [grpData, overallData] = await Promise.all([
      postJson('/ajax_get_league_group_leaderboard', { league: LEAGUE_ID, round: ROUND_TYPE, roundtype: ROUND_TYPE }),
      postJson('/ajax_get_league_overall_leaderboard', { league: LEAGUE_ID, roundtype: ROUND_TYPE })
    ]);

    if (!grpData || grpData.status !== 1) {
      return res.json({status:0});
    }

    // Build live-points lookup from overall leaderboard (teamid -> team data)
    const overallScores = (overallData && overallData.data && overallData.data.allscores)
      ? overallData.data.allscores : [];
    const liveByName = {};
    const liveById   = {};
    overallScores.forEach(t => {
      liveById[t.teamid]   = t;
      liveByName[String(t.teamname).trim().toUpperCase()] = t;
    });

    // Reshape groups: teams_and_scores is an object { allscores: [...] }
    const rawGroups = Array.isArray(grpData.data) ? grpData.data : [];
    const groups = rawGroups.map(g => {
      const tas = g.teams_and_scores || {};
      const rawTeams = Array.isArray(tas) ? tas : (tas.allscores || []);

      const teams = rawTeams.map(t => {
        // Merge live points from overall leaderboard
        const live = liveById[t.teamid] || liveByName[String(t.teamname).trim().toUpperCase()] || {};
        return {
          position:    live.position    || t.position    || 1,
          teamid:      t.teamid,
          teamname:    t.teamname,
          Totalpoints: live.Totalpoints !== undefined ? live.Totalpoints : (t.Totalpoints || 0),
          teamlogo:    live.teamlogo    || t.teamlogo    || '',
          liveStatus:  live.liveStatus  || t.liveStatus  || '',
          roundpoints: live.roundpoints || t.roundpoints || {}
        };
      });

      // Re-sort by Totalpoints desc, then by name for ties
      teams.sort((a, b) => (b.Totalpoints - a.Totalpoints) || a.teamname.localeCompare(b.teamname));

      // Re-assign positions with tied handling
      let pos = 1;
      teams.forEach((t, i) => {
        if (i > 0 && teams[i-1].Totalpoints === t.Totalpoints) {
          t.position = teams[i-1].position;
        } else {
          t.position = pos;
        }
        pos++;
      });

      return {
        groupid:          g.groupid,
        groupname:        g.groupname,
        teams:            teams,
        teams_and_scores: { allscores: teams }
      };
    });

    res.json({
      status: 1,
      round:  ROUND_TYPE,
      groups: groups
    });
  } catch(err){
    console.log("GROUP STANDINGS ERROR:", err);
    res.json({status:0});
  }
});

// 🔥 GET FULL TEAM STANDINGS
app.get('/api/team-standings', async (req,res)=>{
  try{
    const data = await postJson(
      '/ajax_get_league_overall_leaderboard',
      { league: LEAGUE_ID, roundtype: ROUND_TYPE }
    );

    if (!data || data.status !== 1) {
      return res.json({status:0});
    }

    const teams = extractTeams(data);
    const roundLabels = (data.data && data.data.rnd_labels) ? data.data.rnd_labels : ['R1', 'R2', 'R3'];

    res.json({
      status: 1,
      round: ROUND_TYPE,
      rounds: roundLabels,
      teams: teams
    });
  } catch(err){
    console.log("TEAM STANDINGS ERROR:", err);
    res.json({status:0});
  }
});

// 🔥 GET ALL TEAMS FOR DROPDOWN
app.get('/api/team-list', async (req,res)=>{
  try{
    const data = await postJson(
      '/ajax_get_league_overall_leaderboard',
      { league: LEAGUE_ID, roundtype: ROUND_TYPE }
    );

    if (!data || data.status !== 1) {
      return res.json({status:0});
    }

    const teams = extractTeams(data);

    res.json({
      status:1,
      teams
    });

  } catch(err){
    console.log("TEAM LIST ERROR:", err);
    res.json({status:0});
  }
});

// 🔥 GET LEAGUE DRAW & SCHEDULE (FILTERED BY DATE)
app.get('/api/draw', async (req, res) => {
  try {
    const drawData = await postJson(
      '/ajax_get_all_draw_list',
      { league: LEAGUE_ID }
    );

    const teamsData = await postJson(
      '/ajax_get_league_overall_leaderboard',
      { league: LEAGUE_ID, roundtype: ROUND_TYPE }
    );
    const teams = extractTeams(teamsData);

    const groupData = await postJson(
      '/ajax_get_league_group_leaderboard',
      { league: LEAGUE_ID, round: ROUND_TYPE, roundtype: ROUND_TYPE }
    );

    // Fetch individual leaderboard scores to calculate live match play status (AS, 1UP, 1DN, 2UP, etc.)
    const indData = await postJson(
      '/ajax_get_league_individual_leaderboard',
      { league: LEAGUE_ID, round: ROUND_TYPE, roundtype: ROUND_TYPE }
    );
    const allIndividualScores = (indData && indData.data && Array.isArray(indData.data.allscores))
      ? indData.data.allscores
      : [];

    if (Date.now() - playerCacheTime > CACHE_TTL_MS) {
      await refreshPlayerCache();
    }

    const allSessions = (drawData && drawData.data && Array.isArray(drawData.data))
      ? drawData.data
      : [];

    // Filter strictly by requested date (e.g. 2026-11-20 only, do not show next day)
    const targetDate = req.query.date || selectedDrawDate || '2026-11-20';
    const filteredSessions = allSessions.filter(s => String(s.date).trim() === targetDate);
    const sessions = filteredSessions.length > 0 ? filteredSessions : allSessions;

    // Check if the API has round-specific match players in group data
    const activeRoundPlayersByTeam = {};
    if (groupData && groupData.data && Array.isArray(groupData.data)) {
      groupData.data.forEach(g => {
        if (g.teams_and_scores && Array.isArray(g.teams_and_scores.allscores)) {
          g.teams_and_scores.allscores.forEach(t => {
            const rKey = `R${ROUND_TYPE}_players`;
            if (t.roundpoints && Array.isArray(t.roundpoints[rKey]) && t.roundpoints[rKey].length > 0) {
              activeRoundPlayersByTeam[t.teamid] = t.roundpoints[rKey].map(p => typeof p === 'string' ? p : (p.name || p.playername || p.glfname || ''));
            }
          });
        }
      });
    }

    // Determine which matches to serve: date + session filter
    const reqSession = req.query.session || selectedDrawSession;

    let baseMatches;
    if (targetDate === '2026-11-27') {
      // Round 2, Day 1 (Friday, 27 Nov 2026)
      if (reqSession === 'morning') {
        baseMatches = morningScheduleRound2Day1;
      } else if (reqSession === 'afternoon') {
        baseMatches = afternoonScheduleRound2Day1;
      } else {
        baseMatches = allRound2Day1Matches;
      }
    } else if (targetDate === '2026-11-28') {
      // Round 2, Day 2 (Saturday, 28 Nov 2026)
      baseMatches = []; // Awaiting Day 2 draw
    } else if (targetDate === '2026-11-21') {
      // Round 1, Day 2 (Saturday, 21 Nov 2026)
      if (reqSession === 'morning') {
        baseMatches = morningScheduleDay2;
      } else if (reqSession === 'afternoon') {
        baseMatches = afternoonScheduleDay2;
      } else {
        baseMatches = allDay2Matches;
      }
    } else {
      // Round 1, Day 1 (Friday, 20 Nov 2026)
      if (reqSession === 'morning') {
        baseMatches = morningSchedule;
      } else if (reqSession === 'afternoon') {
        baseMatches = afternoonSchedule;
      } else {
        baseMatches = allOfficialMatches;
      }
    }

    // Enrich matches with team logos and live scores
    const enrichedMatches = baseMatches.map(m => {
      const matchCopy = JSON.parse(JSON.stringify(m));
      const t1Info = teams.find(t => t.teamname && t.teamname.trim().toUpperCase() === matchCopy.team1.name.trim().toUpperCase());
      const t2Info = teams.find(t => t.teamname && t.teamname.trim().toUpperCase() === matchCopy.team2.name.trim().toUpperCase());
      
      if (t1Info) {
        matchCopy.team1.teamid = t1Info.teamid;
        matchCopy.team1.teamlogo = t1Info.teamlogo;
        matchCopy.team1.Totalpoints = t1Info.Totalpoints;
        matchCopy.team1.roundpoints = t1Info.roundpoints;
        matchCopy.team1.FinishedHoles = t1Info.FinishedHoles;
        if (t1Info.matchStatus) matchCopy.team1.matchStatus = t1Info.matchStatus;
      }
      if (t2Info) {
        matchCopy.team2.teamid = t2Info.teamid;
        matchCopy.team2.teamlogo = t2Info.teamlogo;
        matchCopy.team2.Totalpoints = t2Info.Totalpoints;
        matchCopy.team2.roundpoints = t2Info.roundpoints;
        matchCopy.team2.FinishedHoles = t2Info.FinishedHoles;
        if (t2Info.matchStatus) matchCopy.team2.matchStatus = t2Info.matchStatus;
      }

      // ── Calculate Live Match Play Status (AS, 1UP, 2UP, 1DN, 2DN, etc.) directly from API ──
      function cleanStr(n) {
        return (n || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      }

      function getPlayerPts(pName, teamName) {
        if (!pName) return 0;
        const c = cleanStr(pName);
        const tc = cleanStr(teamName);

        // 1st: match within the team
        let found = allIndividualScores.find(p => {
          const sameTeam = cleanStr(p.teamname) === tc || cleanStr(p.teamname).includes(tc) || tc.includes(cleanStr(p.teamname));
          if (!sameTeam) return false;
          const fn = cleanStr(p.glfname);
          return fn === c || fn.includes(c) || c.includes(fn);
        });

        // 2nd: fallback across all players
        if (!found) {
          found = allIndividualScores.find(p => {
            const fn = cleanStr(p.glfname);
            return fn === c || fn.includes(c) || c.includes(fn);
          });
        }

        if (!found) return 0;
        // For Round 2 (27 & 28 Nov), read R2 round points. For Round 1 (20 & 21 Nov), read R1 round points.
        if (targetDate === '2026-11-27' || targetDate === '2026-11-28') {
          return Number(found.roundpoints?.R2) || 0;
        } else {
          return Number(found.roundpoints?.R1) || Number(found.Totalpoints) || 0;
        }
      }

      const t1p1Pts = getPlayerPts(matchCopy.team1.players[0]?.name, matchCopy.team1.name);
      const t1p2Pts = getPlayerPts(matchCopy.team1.players[1]?.name, matchCopy.team1.name);
      const t2p1Pts = getPlayerPts(matchCopy.team2.players[0]?.name, matchCopy.team2.name);
      const t2p2Pts = getPlayerPts(matchCopy.team2.players[1]?.name, matchCopy.team2.name);

      const t1Sum = t1p1Pts + t1p2Pts;
      const t2Sum = t2p1Pts + t2p2Pts;

      // Check if manual/control match play override is present for this match
      const manual = manualMatchScores[matchCopy.matchId];
      if (manual) {
        const t1st = (manual.t1Status || '').trim().toUpperCase();
        const t2st = (manual.t2Status || '').trim().toUpperCase();
        if (manual.cleared || (!t1st && !t2st) || t1st === '.' || t1st === 'NONE') {
          // Explicitly cleared / removed from Control Panel -> REMOVE FROM GFX
          matchCopy.team1.matchStatus = '';
          matchCopy.team2.matchStatus = '';
          matchCopy.noScoresYet = true;
        } else {
          // User set a manual status (e.g. 1UP, AS, 2DN) -> KEEP IT AND DISPLAY
          matchCopy.team1.matchStatus = t1st;
          matchCopy.team2.matchStatus = t2st;
          matchCopy.noScoresYet = false;
        }
      } else {
        // No manual override -> Check live API scores
        if (t1Sum > t2Sum) {
          const diff = Math.round(t1Sum - t2Sum);
          matchCopy.team1.matchStatus = `${diff > 0 ? diff : 1}UP`;
          matchCopy.team2.matchStatus = `${diff > 0 ? diff : 1}DN`;
          matchCopy.noScoresYet = false;
        } else if (t2Sum > t1Sum) {
          const diff = Math.round(t2Sum - t1Sum);
          matchCopy.team1.matchStatus = `${diff > 0 ? diff : 1}DN`;
          matchCopy.team2.matchStatus = `${diff > 0 ? diff : 1}UP`;
          matchCopy.noScoresYet = false;
        } else if (t1Sum > 0 && t2Sum > 0 && t1Sum === t2Sum) {
          // Both teams have posted scores and are level -> AS
          matchCopy.team1.matchStatus = 'AS';
          matchCopy.team2.matchStatus = 'AS';
          matchCopy.noScoresYet = false;
        } else {
          // No scores posted in API yet (0-0) -> REMOVED / BLANK (no status badge)
          matchCopy.team1.matchStatus = '';
          matchCopy.team2.matchStatus = '';
          matchCopy.noScoresYet = true;
        }
      }

      return matchCopy;
    });

    res.json({
      status: 1,
      league: LEAGUE_ID,
      round: ROUND_TYPE,
      activeDate: targetDate,
      activeSession: reqSession,
      heldMatchId: selectedDrawMatchId,
      sessions: sessions,
      matches: enrichedMatches,
      totalSessionsInLeague: allSessions.length,
      teams: teams,
      groups: (groupData && groupData.data) || [],
      playersByTeam: Object.keys(activeRoundPlayersByTeam).length > 0 ? activeRoundPlayersByTeam : playerCache,
      isRoundSpecific: Object.keys(activeRoundPlayersByTeam).length > 0
    });
  } catch(err) {
    console.log("DRAW API ERROR:", err);
    res.json({ status: 0 });
  }
});

// Set active draw date (e.g. '2026-11-20')
app.get('/api/set-draw-date', (req, res) => {
  if (req.query.date) {
    selectedDrawDate = req.query.date;
    console.log("Draw Date set to:", selectedDrawDate);
  }
  res.json({ success: true, date: selectedDrawDate });
});

// Control Draw GFX: select session (morning / afternoon / all) or hold on a specific match
app.get('/api/control-draw', (req, res) => {
  if (req.query.session !== undefined) {
    selectedDrawSession = req.query.session || 'all';
    console.log("Draw Session set to:", selectedDrawSession);
  }
  if (req.query.matchId !== undefined) {
    // null or 'auto' means cycle automatically
    selectedDrawMatchId = (req.query.matchId === 'auto' || !req.query.matchId) ? null : req.query.matchId;
    console.log("Draw Match Hold set to:", selectedDrawMatchId || 'AUTO-CYCLE');
  }
  if (req.query.t1Status !== undefined || req.query.t2Status !== undefined) {
    const mId = req.query.matchId || selectedDrawMatchId;
    if (mId && mId !== 'auto') {
      const t1 = (req.query.t1Status !== undefined ? req.query.t1Status : '').trim().toUpperCase();
      const t2 = (req.query.t2Status !== undefined ? req.query.t2Status : '').trim().toUpperCase();

      if (!t1 && !t2 || t1 === '.' || t1 === 'NONE') {
        // User clicked Clear / removed from Control Panel
        manualMatchScores[mId] = { t1Status: '', t2Status: '', cleared: true };
      } else {
        manualMatchScores[mId] = { t1Status: t1, t2Status: t2, cleared: false };
      }
      saveManualScores();
      console.log(`Updated manual match score for ${mId}:`, manualMatchScores[mId]);
    }
  }
  res.json({
    success: true,
    session: selectedDrawSession,
    heldMatchId: selectedDrawMatchId,
    manualScores: manualMatchScores
  });
});

// Select Teams
app.get('/api/select-teams', (req,res)=>{
  selectedTeam1 = req.query.team1;
  selectedTeam2 = req.query.team2;
  selectedHole = req.query.hole || 'HOLE MATCHUP';
  selectedMatchStatus = req.query.matchstatus || 'ALL SQUARE';

  // Players can be passed as comma-separated strings
  selectedPlayers1 = req.query.players1 ? req.query.players1.split(',').map(p=>p.trim()).filter(Boolean) : [];
  selectedPlayers2 = req.query.players2 ? req.query.players2.split(',').map(p=>p.trim()).filter(Boolean) : [];

  console.log("Selected Teams:", selectedTeam1, selectedTeam2, selectedHole, selectedMatchStatus);

  res.json({ success: true, team1: selectedTeam1, team2: selectedTeam2, hole: selectedHole, matchstatus: selectedMatchStatus, players1: selectedPlayers1, players2: selectedPlayers2 });
});

// Clear / Hide Teams Overlay
app.get('/api/clear-teams', (req,res)=>{
  selectedTeam1 = null;
  selectedTeam2 = null;
  selectedHole = null;
  selectedMatchStatus = 'ALL SQUARE';
  selectedPlayers1 = [];
  selectedPlayers2 = [];
  console.log("Cleared Dual Team Overlay");
  res.json({ success: true });
});

// Get Selected Teams Data
app.get('/api/teams', async (req,res)=>{
  try{

    if(!selectedTeam1 || !selectedTeam2){
      return res.json({status:0});
    }

    const data = await postJson(
      '/ajax_get_league_overall_leaderboard',
      { league: LEAGUE_ID, roundtype: ROUND_TYPE }
    );

    if (!data || data.status !== 1) {
      return res.json({status:0});
    }

    const teams = extractTeams(data);

    const team1 = teams.find(t => String(t.teamid) === String(selectedTeam1));
    const team2 = teams.find(t => String(t.teamid) === String(selectedTeam2));

    if(!team1 || !team2){
      return res.json({status:0});
    }

    // ── Get players from individual leaderboard cache (auto, from API) ──
    const apiPlayers1 = await getPlayersForTeam(team1.teamid);
    const apiPlayers2 = await getPlayersForTeam(team2.teamid);

    // If specific players are specified from schedule, use those; otherwise use all team players from API
    const players1 = selectedPlayers1.length > 0 ? selectedPlayers1 : apiPlayers1;
    const players2 = selectedPlayers2.length > 0 ? selectedPlayers2 : apiPlayers2;

    const matchStatus = selectedMatchStatus || 'ALL SQUARE';

    res.json({
      status:1,
      hole: selectedHole || 'HOLE MATCHUP',
      matchstatus: matchStatus,
      team1: { ...team1, players: players1 },
      team2: { ...team2, players: players2 }
    });

  } catch(err){
    console.log("TEAM FETCH ERROR:", err);
    res.json({status:0});
  }
});

// ── Players by team (convenience for control panel) ──
app.get('/api/players-by-team', async (req, res) => {
  try {
    if (Date.now() - playerCacheTime > CACHE_TTL_MS) await refreshPlayerCache();
    res.json({ status: 1, players: playerCache });
  } catch (err) {
    res.json({ status: 0 });
  }
});

// ── Boot: pre-warm player cache, then refresh every 60s ──
refreshPlayerCache();
setInterval(refreshPlayerCache, CACHE_TTL_MS);

app.listen(PORT, () => {
  console.log(`🔥 Dual Team Overlay running at http://localhost:${PORT}`);
});