import { prisma } from './prisma';
import { getProblemByNumber } from './sheetsClient';

export type AttemptResult = {
  awardedXP: number;
  userXP: number;
  attemptNumber: number;
  totalProblemAttempts: number;
  totalProblemSolves: number;
  weightedSolves: number;
  originalBaseScore: number;
  currentBaseScore: number;
};

export type ResetProblemResult = {
  problemNumber: string;
  clearedUserAttempts: number;
  originalBaseScore: number;
  currentBaseScore: number;
};

export type FinalizeProblemResult = {
  problemNumber: string;
  finalBaseScore: number;
  weightedSolves: number;
  adjustedUsers: number;
  initializedUsers: number;
};

export type UnfinalizeProblemResult = {
  problemNumber: string;
  restoredBaseScore: number;
  revertedUsers: number;
};

const SCORE_DECAY = 0.8;
const MAX_WRONG_ATTEMPTS = 5;
const MIN_DYNAMIC_BASE_SCORE = 25;

const CURVE_A1 = 8.90125;
const CURVE_a1 = -0.0279323;
const CURVE_B1 = 24.6239;
const CURVE_b1 = -0.402639;

function getWrongAttempts(attempts: number): number {
  return Math.max(0, Math.min(MAX_WRONG_ATTEMPTS, attempts - 1));
}

function getSolveWeight(attempts: number): number {
  return Math.pow(SCORE_DECAY, getWrongAttempts(attempts));
}

function getDynamicBaseFromWeightedSolves(weightedSolves: number): number {
  const curved =
    CURVE_A1 * Math.exp(CURVE_a1 * weightedSolves) +
    CURVE_B1 * Math.exp(CURVE_b1 * weightedSolves);

  return Math.max(MIN_DYNAMIC_BASE_SCORE, Math.round(curved));
}

async function getWeightedSolves(problemId: string): Promise<number> {
  const solvedAttempts = await prisma.userAttempt.findMany({
    where: { problemId, solved: true },
    select: { attempts: true },
  });

  return solvedAttempts.reduce((sum, attempt) => {
    return sum + getSolveWeight(attempt.attempts);
  }, 0);
}

async function adjustUserXPByDbId(userId: string, delta: number) {
  if (delta === 0) return;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { xp: true },
  });
  if (!user) return;

  const newXP = Math.max(0, user.xp + delta);
  await prisma.user.update({
    where: { id: userId },
    data: { xp: newXP },
  });
}

// Define XP thresholds and corresponding ranks
export const XP_THRESHOLDS = [
  { threshold: 0, display: "Unranked" },
  { threshold: 101, display: "Bronze" },
  { threshold: 201, display: "Silver" },
  { threshold: 351, display: "Gold" },
  { threshold: 501, display: "Platinum" },
  { threshold: 751, display: "Diamond" },
  { threshold: 951, display: "Ascendant" },
  { threshold: 1201, display: "Immortal" },
  { threshold: 1501, display: "Radiant" },
];

// This function calculates the user's rank and progress towards the next rank based on their XP. 
// It returns an object containing the current rank, progress to the next rank, a visual progress bar, and information about the next milestone.
// You can use this function to display user ranks in your Discord bot or any other interface.
export async function getOrCreateUser(discordId: string) {
  let user = await prisma.user.findUnique({ where: { discordId } });
  if (!user) {
    user = await prisma.user.create({ data: { discordId, xp: 0 } });
  }
  return user;
}

// This function takes the user's XP as input and determines their current rank based on predefined thresholds. 
// It also calculates the progress towards the next rank and returns a structured object with all relevant information for display purposes.
export function getRankAndProgress(xp: number) {
  let rank = "Unranked";
  let nextThreshold = 100;

  for (let i = 0; i < XP_THRESHOLDS.length - 1; i++) {
    if (xp >= XP_THRESHOLDS[i].threshold && xp < XP_THRESHOLDS[i + 1].threshold) {
      rank = XP_THRESHOLDS[i].display;
      nextThreshold = XP_THRESHOLDS[i + 1].threshold;
      break;
    } // If XP exceeds the last threshold, it will be handled in the next condition
  }
  if (xp >= XP_THRESHOLDS[XP_THRESHOLDS.length - 1].threshold) {
    rank = XP_THRESHOLDS[XP_THRESHOLDS.length - 1].display;
    nextThreshold = xp + 100;
  } // Calculate progress towards the next rank as a percentage

  const base = XP_THRESHOLDS.find(t => t.display === rank)!.threshold; // Get the XP threshold for the current rank to calculate progress
  const progress = Math.floor(((xp - base) / (nextThreshold - base)) * 100); // Calculate how many filled squares to show in the progress bar (10 total squares)

  const filled = Math.floor(progress / 10); //  Each square represents 10% progress, so we divide the percentage by 10 to get the number of filled squares (0-10)

  // New design: white empty squares with gaps + blue filled squares
  const barArray = [];
  for (let i = 0; i < 10; i++) {
    barArray.push(i < filled ? '🟦' : '⬜');
  }
  const bar = barArray.join(' '); // gap between each square

  return {
    rank,
    progressToNext: `${xp} / ${nextThreshold} XP (${nextThreshold - xp} remaining)`,
    levelProgress: `${bar} ${progress}%`,
    nextMilestone: `${XP_THRESHOLDS.find(t => t.threshold === nextThreshold)?.display || 'Max'} at ${nextThreshold} XP`,
  };
}

// This function adds a specified amount of XP to a user's total. It first retrieves the user's current XP, calculates the new total, and updates the database.
export async function addXP(discordId: string, amount: number, reason: string = '') {
  const user = await getOrCreateUser(discordId);
  const newXP = Math.max(0, user.xp + amount);

  await prisma.user.update({
    where: { discordId },
    data: { xp: newXP }
  });

  console.log(`Added ${amount} XP to ${discordId} (new total: ${newXP}) ${reason ? `- ${reason}` : ''}`);
  return newXP;
}

// This function removes a specified amount of XP from a user's total. It first retrieves the user's current XP, calculates the new total, and updates the database.
export async function removeXP(discordId: string, amount: number, reason: string = '') {
  const user = await getOrCreateUser(discordId);
  const newXP = Math.max(0, user.xp - amount);

  await prisma.user.update({
    where: { discordId },
    data: { xp: newXP }
  });

  console.log(`Removed ${amount} XP from ${discordId} (new total: ${newXP}) ${reason ? `- ${reason}` : ''}`);
  return newXP;
}

export async function resetProblemStats(problemNumber: string): Promise<ResetProblemResult> {
  const problem = await prisma.problem.findUnique({ where: { number: problemNumber } });
  if (!problem) {
    throw new Error(`Problem #${problemNumber} not found in database.`);
  }

  const deleteResult = await prisma.userAttempt.deleteMany({
    where: { problemId: problem.id },
  });

  const resetBaseScore = problem.originalBaseScore > 0 ? problem.originalBaseScore : problem.baseScore;
  const updatedProblem = await prisma.problem.update({
    where: { id: problem.id },
    data: {
      attempts: 0,
      solves: 0,
      baseScore: resetBaseScore,
    },
  });

  return {
    problemNumber: updatedProblem.number,
    clearedUserAttempts: deleteResult.count,
    originalBaseScore: updatedProblem.originalBaseScore,
    currentBaseScore: updatedProblem.baseScore,
  };
}

export async function finalizeProblemScoring(problemNumber: string): Promise<FinalizeProblemResult> {
  const problem = await prisma.problem.findUnique({ where: { number: problemNumber } });
  if (!problem) {
    throw new Error(`Problem #${problemNumber} not found in database.`);
  }
  if (problem.isFinalized) {
    throw new Error(`Problem #${problemNumber} is already finalized.`);
  }

  const solvedAttempts = await prisma.userAttempt.findMany({
    where: { problemId: problem.id, solved: true },
    select: { id: true, userId: true, attempts: true, awardedXp: true, preFinalizeAwardedXp: true },
  });

  const weightedSolves = solvedAttempts.reduce((sum, attempt) => sum + getSolveWeight(attempt.attempts), 0);

  const finalBaseScore = getDynamicBaseFromWeightedSolves(weightedSolves);
  let adjustedUsers = 0;
  let initializedUsers = 0;

  for (const attempt of solvedAttempts) {
    const baselineAward = attempt.preFinalizeAwardedXp ?? attempt.awardedXp;
    const finalAward = Math.floor(finalBaseScore * getSolveWeight(attempt.attempts));
    let delta = 0;

    if (baselineAward === 0) {
      // Legacy rows (before awardedXp tracking) should be initialized without changing XP.
      initializedUsers += 1;
    } else {
      delta = finalAward - baselineAward;
      if (delta !== 0) {
        await adjustUserXPByDbId(attempt.userId, delta);
        adjustedUsers += 1;
      }
    }

    await prisma.userAttempt.update({
      where: { id: attempt.id },
      data: {
        preFinalizeAwardedXp: baselineAward,
        awardedXp: finalAward,
        finalizeDelta: delta,
      },
    });
  }

  await prisma.problem.update({
    where: { id: problem.id },
    data: {
      baseScore: finalBaseScore,
      isFinalized: true,
      finalizedAt: new Date(),
    },
  });

  return {
    problemNumber: problem.number,
    finalBaseScore,
    weightedSolves,
    adjustedUsers,
    initializedUsers,
  };
}

export async function unfinalizeProblemScoring(problemNumber: string): Promise<UnfinalizeProblemResult> {
  const problem = await prisma.problem.findUnique({ where: { number: problemNumber } });
  if (!problem) {
    throw new Error(`Problem #${problemNumber} not found in database.`);
  }
  if (!problem.isFinalized) {
    throw new Error(`Problem #${problemNumber} is not finalized.`);
  }

  const solvedAttempts = await prisma.userAttempt.findMany({
    where: { problemId: problem.id, solved: true },
    select: { id: true, userId: true, awardedXp: true, preFinalizeAwardedXp: true, finalizeDelta: true },
  });

  let revertedUsers = 0;
  for (const attempt of solvedAttempts) {
    if (attempt.preFinalizeAwardedXp == null) {
      continue;
    }

    const reverseDelta = -attempt.finalizeDelta;
    if (reverseDelta !== 0) {
      await adjustUserXPByDbId(attempt.userId, reverseDelta);
      revertedUsers += 1;
    }

    await prisma.userAttempt.update({
      where: { id: attempt.id },
      data: {
        awardedXp: attempt.preFinalizeAwardedXp,
        preFinalizeAwardedXp: null,
        finalizeDelta: 0,
      },
    });
  }

  const weightedSolves = await getWeightedSolves(problem.id);
  const restoredBaseScore = getDynamicBaseFromWeightedSolves(weightedSolves);

  await prisma.problem.update({
    where: { id: problem.id },
    data: {
      baseScore: restoredBaseScore,
      isFinalized: false,
      finalizedAt: null,
    },
  });

  return {
    problemNumber: problem.number,
    restoredBaseScore,
    revertedUsers,
  };
}


export async function recordAttempt(userId: string, problemNumber: string, isCorrect: boolean): Promise<AttemptResult> {
  let problem = await prisma.problem.findUnique({ where: { number: problemNumber } });
  if (!problem) {
    const sheetProblem = await getProblemByNumber(problemNumber);
    const originalBaseScore = parseInt(sheetProblem.baseScore, 10);
    problem = await prisma.problem.create({
      data: {
        number: problemNumber,
        originalBaseScore,
        baseScore: originalBaseScore,
      },
    });
  }
  if (problem.isFinalized) {
    throw new Error(`Problem #${problemNumber} is finalized. Unfinalize it before recording new attempts.`);
  }

  // Backfill originalBaseScore for older rows created before this field existed.
  if (problem.originalBaseScore <= 0) {
    const sheetProblem = await getProblemByNumber(problemNumber);
    const fallbackOriginal = parseInt(sheetProblem.baseScore, 10);
    problem = await prisma.problem.update({
      where: { id: problem.id },
      data: { originalBaseScore: fallbackOriginal },
    });
  }

  // Resolve Discord user to DB user so FK uses User.id (not discordId)
  const dbUser = await getOrCreateUser(userId);

  let userAttempt = await prisma.userAttempt.findUnique({
    where: { userId_problemId: { userId: dbUser.id, problemId: problem.id } },
  });

  if (!userAttempt) {
    userAttempt = await prisma.userAttempt.create({
      data: { userId: dbUser.id, problemId: problem.id },
    });
  }

  // Increment attempts
  const newAttempts = userAttempt.attempts + 1;
  const solvedAfterReview = userAttempt.solved || isCorrect;
  await prisma.userAttempt.update({
    where: { id: userAttempt.id },
    data: { attempts: newAttempts, solved: solvedAfterReview },
  });

  // Update global attempts/solves
  const newlySolved = isCorrect && !userAttempt.solved;
  const newGlobalAttempts = problem.attempts + 1;
  const newGlobalSolves = problem.solves + (newlySolved ? 1 : 0);
  await prisma.problem.update({
    where: { id: problem.id },
    data: { attempts: newGlobalAttempts, solves: newGlobalSolves },
  });

  // Calculate weighted solves from all successful users for this problem.
  const solvedAttempts = await prisma.userAttempt.findMany({
    where: { problemId: problem.id, solved: true },
    select: { attempts: true },
  });

  const weightedSolves = solvedAttempts.reduce((sum, attempt) => {
    return sum + getSolveWeight(attempt.attempts);
  }, 0);

  // Dynamic base score from weighted solves using the curve-fit formula.
  const newBaseScore = getDynamicBaseFromWeightedSolves(weightedSolves);

  await prisma.problem.update({
    where: { id: problem.id },
    data: { baseScore: newBaseScore },
  });

  // Sync new baseScore back to Sheets (optional - implement if needed)
  // await updateSheetBaseScore(problemNumber, newBaseScore);

  if (newlySolved) {
    // Award XP from original base score with attempt decay.
    // Example: original 100 -> attempt #1 = 100, attempt #2 = 80.
    const baseForAward = problem.originalBaseScore > 0 ? problem.originalBaseScore : problem.baseScore;
    const awardedXP = Math.floor(baseForAward * getSolveWeight(newAttempts));
    const userXP = await addXP(userId, awardedXP, `Solved problem #${problemNumber} on attempt ${newAttempts}`);
    await prisma.userAttempt.update({
      where: { id: userAttempt.id },
      data: { awardedXp: awardedXP },
    });
    return {
      awardedXP,
      userXP,
      attemptNumber: newAttempts,
      totalProblemAttempts: newGlobalAttempts,
      totalProblemSolves: newGlobalSolves,
      weightedSolves,
      originalBaseScore: problem.originalBaseScore,
      currentBaseScore: newBaseScore,
    };
  }

  const latestUser = await prisma.user.findUnique({
    where: { id: dbUser.id },
    select: { xp: true },
  });

  return {
    awardedXP: 0,
    userXP: latestUser?.xp ?? dbUser.xp,
    attemptNumber: newAttempts,
    totalProblemAttempts: newGlobalAttempts,
    totalProblemSolves: newGlobalSolves,
    weightedSolves,
    originalBaseScore: problem.originalBaseScore,
    currentBaseScore: newBaseScore,
  };
}
