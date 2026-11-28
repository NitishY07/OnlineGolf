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
function getTodayISTDate() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

let selectedDrawDate = null;             // null = auto-use today's IST date (e.g. '2026-11-28')
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

// ── Clean string helper ──
function cleanStr(n) {
  return (n || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

// ── Match Play Points Cache & Fetcher (ajax_get_league_leaderboardpoints) ──
// Cached PER TEAM so one slow/failed team request never wipes out other teams' data
const leaderboardPointsByTeam = {}; // { "2_teamid": { timestamp: ms, matches: [...] } }
const LEADERBOARD_POINTS_TTL_MS = 15000; // 15 seconds

async function getLeaderboardMatchPoints(targetRound, activeTeamIds) {
  const now = Date.now();
  const list = Array.from(activeTeamIds);
  if (list.length === 0) return [];

  // Find which teams need a refresh (missing or older than 15s)
  const staleIds = list.filter(id => {
    const entry = leaderboardPointsByTeam[`${targetRound}_${id}`];
    return !entry || (now - entry.timestamp >= LEADERBOARD_POINTS_TTL_MS);
  });

  if (staleIds.length > 0) {
    try {
      // Fetch in small batches of 5 to avoid overwhelming the upstream server / hitting timeouts
      const BATCH_SIZE = 5;
      for (let i = 0; i < staleIds.length; i += BATCH_SIZE) {
        const batch = staleIds.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
          batch.map(id =>
            postJson('/ajax_get_league_leaderboardpoints', {
              league: LEAGUE_ID,
              rtype: targetRound,
              teamid: id
            }).then(d => ({ id, d })).catch(() => ({ id, d: null }))
          )
        );

        const rKey = `R${targetRound}_playernames`;
        results.forEach(({ id, d }) => {
          const rp = d && d.data && d.data.scores && d.data.scores[0] && d.data.scores[0].roundpoints;
          if (rp && Array.isArray(rp[rKey])) {
            leaderboardPointsByTeam[`${targetRound}_${id}`] = {
              timestamp: Date.now(),
              matches: rp[rKey]
            };
          }
        });
      }
    } catch (err) {
      console.error('Error fetching ajax_get_league_leaderboardpoints:', err.message);
    }
  }

  // Collect all cached matches for the requested teams
  const collected = [];
  list.forEach(id => {
    const entry = leaderboardPointsByTeam[`${targetRound}_${id}`];
    if (entry && Array.isArray(entry.matches)) {
      collected.push(...entry.matches);
    }
  });
  return collected;
}

function extractMatchPlayStatus(item, isTeam1Direct) {
  let w1 = String(item.team1won || '').trim();
  let w2 = String(item.team2won || '').trim();
  let c1 = String(item.team1_current || '').trim();
  let c2 = String(item.team2_current || '').trim();

  // If match finished with a winner
  if (w1 || w2) {
    function parseWon(s) {
      if (!s) return '';
      const upper = s.toUpperCase();
      if (upper.includes('TIED') || upper === 'ALL SQUARE' || upper === 'AS') return 'AS';
      const m = upper.match(/(?:WON\s+)?(\d+[\s&]+\d+|\d+UP|\d+DN)/i);
      if (m) return m[1].replace(/\s+/g, '');
      return upper;
    }
    const p1 = parseWon(w1);
    const p2 = parseWon(w2);
    if (p1 && !p2) {
      const t1 = p1;
      const t2 = p1.includes('UP') ? p1.replace('UP', 'DN') : (p1.includes('&') ? 'DN' : '');
      return isTeam1Direct ? { t1Status: t1, t2Status: t2 } : { t1Status: t2, t2Status: t1 };
    }
    if (p2 && !p1) {
      const t2 = p2;
      const t1 = p2.includes('UP') ? p2.replace('UP', 'DN') : (p2.includes('&') ? 'DN' : '');
      return isTeam1Direct ? { t1Status: t1, t2Status: t2 } : { t1Status: t2, t2Status: t1 };
    }
    if (p1 && p2) {
      return isTeam1Direct ? { t1Status: p1, t2Status: p2 } : { t1Status: p2, t2Status: p1 };
    }
  }

  // Live in-progress scores
  if (c1 || c2) {
    const t1 = isTeam1Direct ? c1 : c2;
    const t2 = isTeam1Direct ? c2 : c1;
    return { t1Status: t1, t2Status: t2 };
  }

  return { t1Status: '', t2Status: '' };
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
      signal: AbortSignal.timeout(15000)
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

// ── Dynamic Draw List Cache & Fetcher (ajax_draw_list_api) ──
const apiDrawsCache = {}; // { "2026-11-28_2": { timestamp, morning, afternoon, all } }
const API_DRAWS_TTL_MS = 60000;

function mapPlydrawToMatch(item, index, sessionKey, targetDate) {
  const slotTime = String(item.ldr_slot_time || '').trim().toUpperCase();
  const holeNum = String(item.ldr_hole || '1').trim();
  const roundVal = item.roundval || `Qualifying - R${item.ldr_round || '2'}`;
  const sessionLabel = sessionKey === 'morning' ? 'Morning' : 'Afternoon';
  const hc1 = item.TH_1 || item.team1_pl_one_handicap || '';
  const hc2 = item.TH_2 || item.team1_pl_two_handicap || '';
  const hc3 = item.TH_3 || item.team2_pl_one_handicap || '';
  const hc4 = item.TH_4 || item.team2_pl_two_handicap || '';

  return {
    matchId: `API_${item.ldrID || (sessionKey + '_' + (index + 1))}`,
    ldrID: String(item.ldrID || ''),
    sessionKey,
    matchNum: index + 1,
    hole: `Hole ${holeNum}`,
    time: slotTime,
    date: item.ldr_date || targetDate,
    dateLabel: targetDate,
    session: `Round ${item.ldr_round || '2'}, ${sessionLabel}`,
    roundval: roundVal,
    bonusTag: item.category_label || '',
    team1: {
      teamid: item.ldr_team1 || '',
      name: String(item.team1name || '').trim(),
      teamlogo: item.team1logo || '',
      players: [
        { name: String(item.team1player1 || '').trim(), hc: String(hc1) },
        { name: String(item.team1player2 || '').trim(), hc: String(hc2) }
      ].filter(p => p.name)
    },
    team2: {
      teamid: item.ldr_team2 || '',
      name: String(item.team2name || '').trim(),
      teamlogo: item.team2logo || '',
      players: [
        { name: String(item.team2player1 || '').trim(), hc: String(hc3) },
        { name: String(item.team2player2 || '').trim(), hc: String(hc4) }
      ].filter(p => p.name)
    },
    apiTeam1Won: String(item.team1won || '').trim(),
    apiTeam2Won: String(item.team2won || '').trim()
  };
}

async function getApiDrawsForDate(targetDate, targetRound) {
  const key = `${targetDate}_${targetRound}`;
  const now = Date.now();
  if (apiDrawsCache[key] && (now - apiDrawsCache[key].timestamp < API_DRAWS_TTL_MS)) {
    return apiDrawsCache[key];
  }

  const [s1, s2] = await Promise.all([
    postJson('/ajax_draw_list_api', { league: LEAGUE_ID, round: targetRound, date: targetDate, session: '1' }),
    postJson('/ajax_draw_list_api', { league: LEAGUE_ID, round: targetRound, date: targetDate, session: '2' })
  ]);

  const list1 = (s1 && s1.data && Array.isArray(s1.data.plydraw)) ? s1.data.plydraw : [];
  const list2 = (s2 && s2.data && Array.isArray(s2.data.plydraw)) ? s2.data.plydraw : [];

  const morning = list1.map((item, idx) => mapPlydrawToMatch(item, idx, 'morning', targetDate));
  const afternoon = list2.map((item, idx) => mapPlydrawToMatch(item, list1.length + idx, 'afternoon', targetDate));

  if (morning.length > 0 || afternoon.length > 0 || !apiDrawsCache[key]) {
    apiDrawsCache[key] = { timestamp: now, morning, afternoon, all: [...morning, ...afternoon] };
  }
  return apiDrawsCache[key];
}

// ── Metadata Cache (teams, groups, draw list) - cached 60s so /api/draw stays fast & resilient ──
let drawMetaCache = {
  timestamp: 0,
  drawData: null,
  teams: [],
  groupData: null
};
const DRAW_META_TTL_MS = 60000;

// 🔥 GET LEAGUE DRAW & SCHEDULE (FILTERED BY DATE)
app.get('/api/draw', async (req, res) => {
  try {
    const nowMeta = Date.now();
    if (nowMeta - drawMetaCache.timestamp >= DRAW_META_TTL_MS || drawMetaCache.teams.length === 0) {
      const [newDrawData, newTeamsData, newGroupData] = await Promise.all([
        postJson('/ajax_get_all_draw_list', { league: LEAGUE_ID }),
        postJson('/ajax_get_league_overall_leaderboard', { league: LEAGUE_ID, roundtype: ROUND_TYPE }),
        postJson('/ajax_get_league_group_leaderboard', { league: LEAGUE_ID, round: ROUND_TYPE, roundtype: ROUND_TYPE })
      ]);
      const extractedTeams = extractTeams(newTeamsData);
      if (newDrawData && newDrawData.status === 1) drawMetaCache.drawData = newDrawData;
      if (extractedTeams.length > 0) drawMetaCache.teams = extractedTeams;
      if (newGroupData && newGroupData.status === 1) drawMetaCache.groupData = newGroupData;
      if (drawMetaCache.teams.length > 0) drawMetaCache.timestamp = nowMeta;
    }

    const drawData = drawMetaCache.drawData;
    const teams = drawMetaCache.teams;
    const groupData = drawMetaCache.groupData;

    // Default to today's IST date if not explicitly set
    const targetDate = req.query.date || selectedDrawDate || getTodayISTDate();

    if (Date.now() - playerCacheTime > CACHE_TTL_MS) {
      await refreshPlayerCache();
    }

    const allSessions = (drawData && drawData.data && Array.isArray(drawData.data))
      ? drawData.data
      : [];

    // Filter strictly by requested date (e.g. 2026-11-28)
    const filteredSessions = allSessions.filter(s => String(s.date).trim() === targetDate);
    const sessions = filteredSessions.length > 0 ? filteredSessions : allSessions;

    const matchedSessionMeta = filteredSessions[0];
    const targetRound = (matchedSessionMeta && matchedSessionMeta.round)
      ? String(matchedSessionMeta.round)
      : ((targetDate === '2026-11-20' || targetDate === '2026-11-21') ? '1' : '2');

    // Check if the API has round-specific match players in group data
    const activeRoundPlayersByTeam = {};
    if (groupData && groupData.data && Array.isArray(groupData.data)) {
      groupData.data.forEach(g => {
        if (g.teams_and_scores && Array.isArray(g.teams_and_scores.allscores)) {
          g.teams_and_scores.allscores.forEach(t => {
            const rKey = `R${targetRound}_players`;
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
    if (targetDate === '2026-11-20') {
      // Round 1, Day 1 (Friday, 20 Nov 2026)
      if (reqSession === 'morning') {
        baseMatches = morningSchedule;
      } else if (reqSession === 'afternoon') {
        baseMatches = afternoonSchedule;
      } else {
        baseMatches = allOfficialMatches;
      }
    } else if (targetDate === '2026-11-21') {
      // Round 1, Day 2 (Saturday, 21 Nov 2026)
      if (reqSession === 'morning') {
        baseMatches = morningScheduleDay2;
      } else if (reqSession === 'afternoon') {
        baseMatches = afternoonScheduleDay2;
      } else {
        baseMatches = allDay2Matches;
      }
    } else if (targetDate === '2026-11-27') {
      // Round 2, Day 1 (Friday, 27 Nov 2026)
      if (reqSession === 'morning') {
        baseMatches = morningScheduleRound2Day1;
      } else if (reqSession === 'afternoon') {
        baseMatches = afternoonScheduleRound2Day1;
      } else {
        baseMatches = allRound2Day1Matches;
      }
    } else {
      // Today (2026-11-28) & all other dates: fetch draws live from ajax_draw_list_api!
      const apiDraws = await getApiDrawsForDate(targetDate, targetRound);
      if (reqSession === 'morning') {
        baseMatches = apiDraws.morning;
      } else if (reqSession === 'afternoon') {
        baseMatches = apiDraws.afternoon;
      } else {
        baseMatches = apiDraws.all;
      }
    }

    // Collect ONLY 1 team ID per unique pairing in baseMatches (e.g. 5 teams per session, 10 for full day)
    // Because ajax_get_league_leaderboardpoints for Team A already returns all matches against Team B!
    const activeTeamIds = new Set();
    const seenPairings = new Set();
    baseMatches.forEach(m => {
      const n1 = cleanStr(m.team1?.name);
      const n2 = cleanStr(m.team2?.name);
      const pairKey = [n1, n2].sort().join('_vs_');
      if (seenPairings.has(pairKey)) return;
      seenPairings.add(pairKey);

      const t1 = teams.find(t => t.teamname && cleanStr(t.teamname) === n1);
      const t2 = teams.find(t => t.teamname && cleanStr(t.teamname) === n2);
      if (t1 && t1.teamid) {
        activeTeamIds.add(t1.teamid);
      } else if (t2 && t2.teamid) {
        activeTeamIds.add(t2.teamid);
      }
    });

    // Fetch live match play status from ajax_get_league_leaderboardpoints (per-team cached 15s, batched)
    const liveMatchPlayData = await getLeaderboardMatchPoints(targetRound, activeTeamIds);

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

      // ── Live Match Play Status from ajax_get_league_leaderboardpoints ──
      const t1Clean = cleanStr(matchCopy.team1.name);
      const t2Clean = cleanStr(matchCopy.team2.name);
      const mHoleNum = (matchCopy.hole || '').replace(/[^0-9]/g, '');
      const mTimeClean = cleanStr(matchCopy.time);
      const mCat = cleanStr(matchCopy.bonusTag || '');
      const mSession = (matchCopy.sessionKey === 'morning') ? '1' : (matchCopy.sessionKey === 'afternoon') ? '2' : '';

      // Find this match in liveMatchPlayData (from ajax_get_league_leaderboardpoints)
      let matchedLive = null;
      if (matchCopy.ldrID) {
        matchedLive = liveMatchPlayData.find(apiM => {
          const drw = apiM.drw1 && apiM.drw1[0];
          return drw && String(drw.ldrID || '') === String(matchCopy.ldrID);
        });
      }
      if (!matchedLive) {
        matchedLive = liveMatchPlayData.find(apiM => {
          const a1 = cleanStr(apiM.team1);
          const a2 = cleanStr(apiM.team2);
          const teamsMatch = (a1 === t1Clean && a2 === t2Clean) || (a1 === t2Clean && a2 === t1Clean);
          if (!teamsMatch) return false;

          const drw = apiM.drw1 && apiM.drw1[0];
          const aDate = String(drw ? (drw.crw_date || '') : '').trim();
          const aHole = String(drw ? drw.ldr_hole : '').trim();
          const aTime = cleanStr(drw ? drw.ldr_slot_time : '');
          const aCat = cleanStr(apiM.category_label || '');
          const aSession = String(drw ? drw.crw_session : '');

          // Filter by exact date (prevents yesterday's score from bleeding into today)
          if (aDate && targetDate && aDate !== targetDate) return false;
          // Filter by session (morning=1, afternoon=2)
          if (mSession && aSession && mSession !== aSession) return false;

          // Best match: same category label (e.g. "P1 - Seq Match")
          if (mCat && aCat && mCat === aCat) return true;
          // Fallback: same time + same hole
          if (mTimeClean && aTime && mTimeClean.slice(0, 4) === aTime.slice(0, 4) && (!mHoleNum || !aHole || mHoleNum === aHole)) return true;
          return false;
        });
      }

      let liveT1Status = '';
      let liveT2Status = '';

      if (matchedLive) {
        const isDirect = cleanStr(matchedLive.team1) === t1Clean;
        const result = extractMatchPlayStatus(matchedLive, isDirect);
        liveT1Status = result.t1Status;
        liveT2Status = result.t2Status;
      } else if (matchCopy.apiTeam1Won || matchCopy.apiTeam2Won) {
        const result = extractMatchPlayStatus({
          team1won: matchCopy.apiTeam1Won,
          team2won: matchCopy.apiTeam2Won
        }, true);
        liveT1Status = result.t1Status;
        liveT2Status = result.t2Status;
      }

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
      } else if (liveT1Status || liveT2Status) {
        // Live match play status from ajax_get_league_leaderboardpoints
        matchCopy.team1.matchStatus = liveT1Status;
        matchCopy.team2.matchStatus = liveT2Status;
        matchCopy.noScoresYet = false;
      } else {
        // No live data yet -> blank
        matchCopy.team1.matchStatus = '';
        matchCopy.team2.matchStatus = '';
        matchCopy.noScoresYet = true;
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