import { Client, GatewayIntentBits, Events, REST, Routes, GuildMember, ChannelType, EmbedBuilder, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Partials } from 'discord.js';
import dotenv from 'dotenv';
import { DateTime } from 'luxon';
import { getMainSheet, getProblemByNumber } from './lib/sheetsClient';
import { renderLatex } from './lib/latexRenderer';
import { getProblemByDate } from './lib/sheetsClient';
import { getOrCreateUser, getRankAndProgress, removeXP, addXP, recordAttempt, resetProblemStats, finalizeProblemScoring, unfinalizeProblemScoring } from './lib/xpSystem';
import { prisma } from './lib/prisma';

dotenv.config(); // Load environment variables.

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageReactions,
  ],
  partials: [Partials.Channel], // Required for handling DMs
}); // Create a new Discord client instance with necessary intents to read messages and content.

client.once(Events.ClientReady, async (c) => {
  console.log(`Bot is online! Logged in as ${c.user.tag}`); //Bot logs in.

// ==================== Google sheets ====================
  try {
    await getMainSheet();  //sheetsClient.ts, this will attempt to connect to the main sheet and log success or failure.
  } catch (err) {
    console.error('Sheets connection failed:', err); // If connection fails.
  }

  // ==================== REGISTER SLASH COMMANDS (Guild-only - instant) ====================
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN!); 
  // Create a new REST client for interacting with Discord's API, using the bot token from environment variables.

  const guildId = process.env.GUILD_ID; 
  // Get the guild ID from environment variables for guild-specific command registration.

  // Define the slash commands to register
  const commands = [
    // /fetch command
    new SlashCommandBuilder()
      .setName('fetch')
      .setDescription('Fetch a specific problem number.')
      .addStringOption(option =>
        option.setName('number')
          .setDescription('Problem number from the sheet.')
          .setRequired(true))
      .toJSON(),

    // /xp command
    new SlashCommandBuilder()
      .setName('xp')
      .setDescription('Show your Physics Club XP profile.')
      .toJSON(),

    // /addxp command (Curator-only)
    new SlashCommandBuilder()
      .setName('addxp')
      .setDescription('Add XP to a user (Curator only).')
      .addUserOption(option => option.setName('user').setDescription('The user to give XP to').setRequired(true))
      .addIntegerOption(option => option.setName('amount').setDescription('Amount of XP to add').setRequired(true))
      .addStringOption(option => option.setName('reason').setDescription('Reason for adding XP').setRequired(false))
      .toJSON(),

    // /removexp command (Curator-only)
    new SlashCommandBuilder()
      .setName('removexp')
      .setDescription('Remove XP from a user (Curator only).')
      .addUserOption(option => option.setName('user').setDescription('The user to remove XP from').setRequired(true))
      .addIntegerOption(option => option.setName('amount').setDescription('Amount of XP to remove').setRequired(true))
      .addStringOption(option => option.setName('reason').setDescription('Reason for removing XP').setRequired(false))
      .toJSON(),

    // /finalize command (Curator-only)
    new SlashCommandBuilder()
      .setName('finalize')
      .setDescription('Finalize scoring for a specific problem (Curator only).')
      .addStringOption(option =>
        option.setName('number')
          .setDescription('Problem number to finalize (default: current active problem).')
          .setRequired(false))
      .toJSON(),

    // /unfinalize command (Curator-only)
    new SlashCommandBuilder()
      .setName('unfinalize')
      .setDescription('Reverse finalize for a specific problem (Curator only).')
      .addStringOption(option =>
        option.setName('number')
          .setDescription('Problem number to unfinalize.')
          .setRequired(true))
      .toJSON()
  ];
 
  // Register commands with Discord API
  try {
    if (guildId) {
      // Guild-specific registration - appears instantly (no global delay)
      await rest.put(
        Routes.applicationGuildCommands(c.user.id, guildId), 
        // Register commands to a specific guild for instant availability
        { body: commands } // The body of the request contains the array of command definitions we created above.
      );
      console.log(`/fetch, /xp, /addxp, /removexp, /finalize, /unfinalize registered to guild ${guildId} (instant)`); // Log success message with guild ID.
    } else {
      console.warn('GUILD_ID not set in .env — commands will not appear'); // Warn if GUILD_ID is not set, which means commands won't be registered anywhere.
    }
  } catch (error) {
    console.error('Slash command registration failed:', error);
  }
});

// ==================== ANSWER-REVIEW DM SYSTEM ====================
const cooldowns = new Map<string, number>(); // userId -> cooldown end timestamp
const pendingReviews = new Set<string>(); // userIds waiting for curator review
const COOLDOWN_MS = 2 * 60 * 1000;
let activeProblemNumber: string | null = process.env.CURRENT_PROBLEM_NUMBER?.trim() || null;

function getCurrentProblemNumber() {
  return activeProblemNumber || '1';
}

// Button handler for answer-review
client.on(Events.InteractionCreate, async (interaction) => { // Listen for interactions, which include button clicks in the answer-review system.
  if (!interaction.isButton()) return; // Only handle button interactions, ignore other types of interactions (like slash commands or select menus).
  const customId = interaction.customId;
  const [action, ...parts] = customId.split('_');
  if (action === 'done') return;

  const hasCuratorRole = (interaction.member as GuildMember)?.roles.cache.some(role => role.name === 'Curator'); 
  if (!hasCuratorRole) {
    await interaction.reply({ content: 'Only Curators can use these buttons.', ephemeral: true });
    return;
  }

  if (action === 'reset') {
    const problemNumber = parts.join('_');
    if (!problemNumber) {
      await interaction.reply({ content: 'Invalid reset button payload.', ephemeral: true });
      return;
    }

    try {
      const reset = await resetProblemStats(problemNumber);
      await interaction.reply(
        `Reset complete for **Problem #${reset.problemNumber}**.\n` +
        `Cleared attempts: **${reset.clearedUserAttempts}**\n` +
        `Base score reset to: **${reset.currentBaseScore}** (original: ${reset.originalBaseScore})`
      );
    } catch (error: any) {
      await interaction.reply({ content: `Reset failed: ${error.message}`, ephemeral: true });
    }
    return;
  }

  if (action !== 'correct' && action !== 'wrong') {
    await interaction.reply({ content: 'Unknown review action.', ephemeral: true });
    return;
  }

  const userId = parts[0];
  const problemNumber = parts.slice(1).join('_') || getCurrentProblemNumber();
  if (!userId) {
    await interaction.reply({ content: 'Invalid review button payload.', ephemeral: true });
    return;
  }

  const targetUser = await client.users.fetch(userId);

  // ==================== SCORING INTEGRATION ====================
  const isCorrect = action === 'correct';
  const result = await recordAttempt(userId, problemNumber, isCorrect);

  if (isCorrect) {
    await interaction.reply(`Marked as **Correct** for ${targetUser} (+${result.awardedXP} XP).`);
  } else {
    await interaction.reply(`Marked as **Wrong** for ${targetUser}. (+0 XP)`);
  }

  let wasLogged = false;
  const attemptLogChannelId = process.env.ATTEMPT_LOG_CHANNEL_ID;
  const fallbackLogChannel = interaction.channel;
  if (attemptLogChannelId || fallbackLogChannel) {
    try {
      const attemptLogChannel = attemptLogChannelId
        ? await client.channels.fetch(attemptLogChannelId)
        : fallbackLogChannel;
      if (attemptLogChannel && attemptLogChannel.isTextBased() && 'send' in attemptLogChannel) {
        const logEmbed = new EmbedBuilder()
          .setColor(isCorrect ? 0x22c55e : 0xef4444)
          .setTitle('Attempt Reviewed')
          .addFields(
            { name: 'User', value: `${targetUser}`, inline: true },
            { name: 'Reviewed By', value: `${interaction.user}`, inline: true },
            { name: 'Verdict', value: isCorrect ? 'Correct' : 'Wrong', inline: true },
            { name: 'Problem', value: `#${problemNumber}`, inline: true },
            { name: 'XP Added', value: `${result.awardedXP}`, inline: true },
            { name: 'User Total XP', value: `${result.userXP}`, inline: true },
            { name: 'Total Solves', value: `${result.totalProblemSolves}`, inline: true },
            { name: 'Total Attempts', value: `${result.totalProblemAttempts}`, inline: true },
            { name: 'Weighted Solves', value: `${result.weightedSolves.toFixed(3)}`, inline: true },
            { name: 'User Attempt #', value: `${result.attemptNumber}`, inline: true },
            { name: 'Original Base Score', value: `${result.originalBaseScore}`, inline: true },
          )
          .setFooter({ text: `Current Base Score: ${result.currentBaseScore}` })
          .setTimestamp();

        await attemptLogChannel.send({ embeds: [logEmbed] });
        wasLogged = true;
      }
    } catch (error) {
      console.error('Failed to send attempt log message:', error);
    }
  }

  if (!isCorrect) {
    cooldowns.set(userId, Date.now() + COOLDOWN_MS);
  }
  if (wasLogged) {
    pendingReviews.delete(userId);
  }

  // Here we handle the three possible actions: "correct", "wrong".
  // For "correct", we simply reply that the answer was marked as correct.
  // For "wrong", we set a cooldown for the user (so they can't immediately submit another answer) and reply that it was marked as wrong. 
  // For "disable", we reply that the problem has been disabled for the user.

  const row = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder().setCustomId('done').setLabel('Processed').setStyle(ButtonStyle.Secondary).setDisabled(true)
    ); 
    // After processing the action, we create a new button that is disabled and labeled "Processed" to replace the original buttons, indicating that the review has been completed and preventing further clicks.

  await interaction.message.edit({ components: [row] });
});

// ==================== LaTeX RENDER ON PING & DM HANDLING ====================
client.on(Events.MessageCreate, async (message) => {
  console.log(`[MessageCreate] Author: ${message.author.tag}, Channel Type: ${message.channel.type}, isDM: ${message.channel.isDMBased()}`);
  
  if (message.author.bot) return; // Ignore messages from bots to prevent loops

  // ===== HANDLE DMs =====
  if (message.channel.type === ChannelType.DM) {
    console.log(`Received DM from ${message.author.tag}: ${message.content}`); 
    // Log the DM content and author for debugging purposes.

    try {
      const reviewChannel = await client.channels.fetch(process.env.ANSWER_REVIEW_CHANNEL_ID!); 
      // Fetch the review channel using the ID from environment variables, where DMs will be forwarded for review by Curators.

      if (!reviewChannel || !reviewChannel.isTextBased()) {
        console.log(`Review channel not found or inaccessible.`);
        await message.reply('Review channel not configured.');
        return;
      }

      if (!('send' in reviewChannel)) {
        console.log(`Review channel is not a text channel.`);
        await message.reply('Review channel cannot send messages.');
        return;
      }

      const currentProblemNumber = getCurrentProblemNumber();
      const dbUser = await getOrCreateUser(message.author.id);
      const currentProblem = await prisma.problem.findUnique({ where: { number: currentProblemNumber } });
      if (currentProblem) {
        const attempt = await prisma.userAttempt.findUnique({
          where: { userId_problemId: { userId: dbUser.id, problemId: currentProblem.id } },
          select: { solved: true },
        });
        if (attempt?.solved) {
          await message.reply('You already solved the current problem. New submissions are blocked.');
          return;
        }
      }

      if (pendingReviews.has(message.author.id)) {
        await message.reply('Your previous attempt is still pending curator review. Please wait.');
        return;
      }

      // Cooldown check
      const cooldownEnd = cooldowns.get(message.author.id);
      if (cooldownEnd && Date.now() < cooldownEnd) {
        await message.reply('Please wait 2 minutes before sending another attempt.'); 
        return;
      }

      // Forward to review channel
      const embed = new EmbedBuilder()
        .setAuthor({
          name: message.author.username,
          iconURL: message.author.displayAvatarURL()
        })
        .setDescription(message.content || '*No text*')
        .setColor(0x5865F2)
        .setTimestamp();

      // Separate images and other files
      const imageAttachments = message.attachments.filter(att => att.contentType?.startsWith('image/'));
      const otherAttachments = message.attachments.filter(att => !att.contentType?.startsWith('image/'));

      // Add the text that images are attached.
      if (imageAttachments.size > 0) {
        embed.setDescription(`Images are Attached.`);
      }

      const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`correct_${message.author.id}_${currentProblemNumber}`)
            .setLabel('Correct')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`wrong_${message.author.id}_${currentProblemNumber}`)
            .setLabel('Wrong')
            .setStyle(ButtonStyle.Danger),
        );

      // Prepare all files to attach (images + other files)
      const files = message.attachments
        .map(att => ({ attachment: att.url, name: att.name || 'attachment' }));

      await reviewChannel.send({
        content: `**New DM from ${message.author}**`,
        embeds: [embed],
        components: [row],
        files: files.length > 0 ? files : undefined
      });

      pendingReviews.add(message.author.id);
      await message.reply('Your answer has been submitted for review.');
    } catch (err) {
      console.error('Error handling DM:', err);
      await message.reply('Error processing your submission. Please try again.');
    }
    return; // Stop processing - this is a DM, not a server message
  }

  // ===== HANDLE GUILD MESSAGES (LaTeX mentions) =====
  const botId = client.user?.id;
  if (!botId) return;

  const mention = `<@${botId}>`; // The mention string that users will use to trigger LaTeX rendering. It looks like "<@123456789012345678>" where the numbers are the bot's user ID.
  const trimmed = message.content.trim(); // Trim whitespace from the message content to ensure we can accurately check for the mention at the start of the message.

  if (!trimmed.startsWith(mention)) return; // If the message doesn't start with the mention, we ignore it.

  const text = trimmed.slice(mention.length).trim(); // Extract the text that comes after the mention, which is what we will attempt to render as LaTeX or interpret as a date for fetching a problem.

  if (!text) {
    await message.reply('Send LaTeX text or "today" after pinging me!');
    return;
  }
  // Only allow "today" for daily fetch.
  const isTodayFetch = text.toLowerCase() === 'today';

  if (isTodayFetch) {
    // === CURATOR ROLE CHECK ===
    const hasCuratorRole = message.member?.roles.cache.some(role => role.name === 'Curator');
    if (!hasCuratorRole) {
      await message.reply('Only members with the **Curator** role can use the daily problem fetch.');
      return;
    }

    await message.channel.sendTyping();

    try {
      const problem = await getProblemByDate('today');
      const fetchedProblemNumber = problem.number?.toString().trim();
      if (!activeProblemNumber && fetchedProblemNumber) {
        activeProblemNumber = fetchedProblemNumber;
      }

      if (!problem.problemLatex) {
        await message.reply('No LaTeX in column I for this date.'); // If there is no LaTeX content for the problem (i.e., column I is empty), we reply to the user indicating that there is no LaTeX available for this date, and then we stop processing further by returning early.
        return;
      }

      // 1. Send LaTeX image
      const imageBuffer = await renderLatex(problem.problemLatex);
      await message.channel.send({
        content: `**Problem for ${problem.date}**`,
        files: [{ attachment: imageBuffer, name: 'problem.png' }]
      });

      // 2. Wait 15 seconds
      await new Promise(resolve => setTimeout(resolve, 15000));

      // 3. Send metadata embed
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`Problem ${problem.number || ''}: ${problem.date}, ${problem.day}`)
        .setDescription(problem.source || 'No source')
        .addFields(
          { name: 'Curator', value: problem.curator || 'N/A', inline: true },
          { name: 'Genre', value: problem.genre || 'N/A', inline: true },
          { name: 'Difficulty', value: problem.difficulty || 'N/A', inline: true },
          { name: 'Hint', value: problem.hint1 ? '✅' : '❌', inline: true },
          { name: 'Answer', value: problem.answer ? '✅' : '❌', inline: true },
          { name: 'Solution', value: problem.solution ? '✅' : '❌', inline: true },
        );

      const windowEndDate = DateTime.fromFormat(problem.date, 'yyyy-MM-dd', { zone: 'Asia/Kolkata' })
        .plus({ days: 1 })
        .toFormat('yyyy-MM-dd');
      embed.setFooter({
        text: `Base Score: ${problem.baseScore || 'N/A'} | Window: 12:00 IST (${problem.date}) to 12:00 IST (${windowEndDate})`,
      })
        .setTimestamp();

      // Try to fetch the curator's avatar
      if (problem.userid && problem.userid !== 'N/A') {
        try {
          const user = await client.users.fetch(problem.userid);
          if (user && user.displayAvatarURL()) {
            embed.setThumbnail(user.displayAvatarURL({ size: 512, extension: 'png' }));
          }
        } catch (err) {
          console.log(`Could not fetch avatar for user: ${problem.userid}`);
        }
      }

      const resetComponents = problem.number
        ? [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(`reset_${problem.number}`)
                .setLabel('Reset Stats')
                .setStyle(ButtonStyle.Secondary)
            ),
          ]
        : [];

      await message.channel.send({
        embeds: [embed],
        components: resetComponents,
      });
    } catch (err) {
      console.error(err);
      await message.reply(`❌ No problem found for today.`);
    }
  } else {
    // Normal quick LaTeX render
    try {
      await message.channel.sendTyping();
      const imageBuffer = await renderLatex(text);
      await message.channel.send({
        files: [{ attachment: imageBuffer, name: 'latex.png' }]
      });
    } catch (err) {
      await message.reply('Failed to render LaTeX.');
    }
  }
});

// ==================== SLASH COMMANDS ====================
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;  // Only handle slash commands

  // Handle /fetch command
  if (interaction.commandName === 'fetch') {
    const number = interaction.options.getString('number', true); // Get the "number" option from the slash command, which is required (true)

    await interaction.deferReply();

    try {
      const problem = await getProblemByNumber(number); // Fetch problem data from Google Sheets based on the provided problem number (column A)

      if (!problem.problemLatex) {
        await interaction.editReply('No LaTeX found for this problem number.');
        return;
      }

      const imageBuffer = await renderLatex(problem.problemLatex);

      await interaction.editReply({
        content: `**Problem #${number}**`,
        files: [{ attachment: imageBuffer, name: `problem-${number}.png` }]
      });
    } catch (err: any) {
      console.error(err);
      await interaction.editReply(`Problem #${number} not found or error: ${err.message}`);
    }
  }

  // Handle /finalize command (Curator-only)
  if (interaction.commandName === 'finalize') {
    const hasCuratorRole = (interaction.member as GuildMember)?.roles.cache.some(role => role.name === 'Curator');
    if (!hasCuratorRole) {
      await interaction.reply({ content: 'Only Curators can use this command.', ephemeral: true });
      return;
    }

    const number = interaction.options.getString('number')?.trim() || getCurrentProblemNumber();
    await interaction.deferReply({ ephemeral: true });

    try {
      const finalized = await finalizeProblemScoring(number);
      const todayProblem = await getProblemByDate('today').catch(() => null);
      const nextProblemNumber = todayProblem?.number?.toString().trim();
      if (nextProblemNumber && nextProblemNumber !== finalized.problemNumber) {
        activeProblemNumber = nextProblemNumber;
      }

      await interaction.editReply(
        `Finalized **Problem #${finalized.problemNumber}**\n` +
        `Final Base: **${finalized.finalBaseScore}**\n` +
        `Weighted Solves: **${finalized.weightedSolves.toFixed(3)}**\n` +
        `XP adjusted users: **${finalized.adjustedUsers}**\n` +
        `Initialized legacy rows: **${finalized.initializedUsers}**\n` +
        `Active problem: **#${getCurrentProblemNumber()}**`
      );
    } catch (err: any) {
      await interaction.editReply(`Finalize failed: ${err.message}`);
    }
  }

  // Handle /unfinalize command (Curator-only)
  if (interaction.commandName === 'unfinalize') {
    const hasCuratorRole = (interaction.member as GuildMember)?.roles.cache.some(role => role.name === 'Curator');
    if (!hasCuratorRole) {
      await interaction.reply({ content: 'Only Curators can use this command.', ephemeral: true });
      return;
    }

    const number = interaction.options.getString('number', true).trim();
    await interaction.deferReply({ ephemeral: true });

    try {
      const reverted = await unfinalizeProblemScoring(number);
      activeProblemNumber = reverted.problemNumber;
      await interaction.editReply(
        `Unfinalized **Problem #${reverted.problemNumber}**\n` +
        `Restored Base: **${reverted.restoredBaseScore}**\n` +
        `Users reverted: **${reverted.revertedUsers}**\n` +
        `Active problem: **#${getCurrentProblemNumber()}**`
      );
    } catch (err: any) {
      await interaction.editReply(`Unfinalize failed: ${err.message}`);
    }
  }
});

// /xp command
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'xp') return; // Only handle the /xp command

  await interaction.deferReply(); // Defer the reply to give us more time to fetch data and build the embed

  const user = interaction.user; // Get the user who invoked the command
  const dbUser = await getOrCreateUser(user.id); // Fetch the user's XP data from the database, or create a new entry if they don't exist
  const stats = getRankAndProgress(dbUser.xp); // Calculate the user's rank and progress towards the next rank based on their XP

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setAuthor({ 
      name: `${user.username}'s Physics Club XP Profile`,  
      iconURL: user.displayAvatarURL()  // Use the user's avatar as the author icon for a personalized touch
    })
    .setThumbnail(user.displayAvatarURL({ size: 1024 })) 
    // The embed includes the user's current rank, total XP, progress towards the next rank, a visual progress bar, and information about the next milestone. The footer includes a dynamic date to show when the profile was last updated.
    .addFields(
      { name: 'Rank', value: stats.rank, inline: true },
      { name: 'XP', value: dbUser.xp.toString(), inline: true },
      { name: 'Progress to Next Rank', value: stats.progressToNext, inline: false },
      { name: 'Level Progress', value: stats.levelProgress, inline: false },
      { name: 'Next Milestone', value: stats.nextMilestone, inline: false },
    )
    .setFooter({ 
      text: 'Physics Club Bot • Participate to level up! • ' + new Date().toLocaleString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' }) 
    }); // Footer includes a dynamic date to show when the profile was last updated

  await interaction.editReply({ embeds: [embed] });
});

// /addxp and /removexp (Curator-only)
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return; // Only handle slash commands
  // /addxp and /removexp (Curator-only)
  if (interaction.commandName === 'addxp' || interaction.commandName === 'removexp') {
  const hasCuratorRole = (interaction.member as GuildMember)?.roles.cache.some(role => role.name === 'Curator');
  if (!hasCuratorRole) {
    await interaction.reply({ content: 'Only Curators can use this command.', ephemeral: true });
    return;
  }

  const targetUser = interaction.options.getUser('user', true);
  const amount = interaction.options.getInteger('amount', true);
  const reason = interaction.options.getString('reason') || 'No reason provided';

  let newXP: number;
  if (interaction.commandName === 'addxp') {
    newXP = await addXP(targetUser.id, amount, reason);
    await interaction.reply(`Added **${amount} XP** to ${targetUser} (new total: **${newXP}**)\nReason: ${reason}`);
  } else {
    newXP = await removeXP(targetUser.id, amount, reason);
    await interaction.reply(`Removed **${amount} XP** from ${targetUser} (new total: **${newXP}**)\nReason: ${reason}`);
  }
}
});

client.login(process.env.DISCORD_TOKEN);
