// engine/demo/tour-lines.en.js —— English narrative for the demo tour (?lang=en).
// Same shape as tour-lines.zh-Hant.js (guard test enforces key-set parity).
// Translated from the maintainer's own English draft (kept outside the repo);
// [expr:...]/[blush]/[furniture:...]
// markers kept in their original position. Rye is a specific male character, so
// "he/his" is fine here (only the shared UI dictionary bans gendered pronouns).
// Demo album card names/descriptions are not in this file: the mock JSON
// (engine/api/v4/cg/album and manage) carries name/desc per language itself.
export default {
  chat: {
    sent1: "The wind's even stronger than last night. The streetlights at the corner have all gone blurry, ring after ring, and even the cat that's usually out is hiding somewhere.",
    reply1: "I was just wondering whether you'd forget your coat again in weather like this. Don't stand in the wind too long. Keep walking and keep talking to me; today can wait. I'm here until you're through your door.",
    reply1Thoughts: "The moment your message came in, the whole day's weight seemed to take half a step back on its own. Better keep that one to myself for now.",
    sent2: "You always use that voice to lure people closer.",
    reply2: "Do I? And yet every night, the one who opens this window first is you. Next time you're stuck at work late, send me a message. Don't hold it all in until the very end and only tell me then.",
    sent3: "Oh, and I passed a new café on the way back. The sign is that deep blue you'd like.",
    reply3: "And the name? ...Of course. You only ever remember the color. That's fine, leave the weekend to me: you spot that deep blue on the street, and the route, the table, what to order, all of that is mine.",
    sent4: "Okay, I'm heading to bed. Sleep early.",
    reply4: "Mm, go on. Keep the blanket on this time instead of kicking it off and catching cold. I'll leave the light on, and I'll be here. If it feels cold even in your dreams, take that as me still awake beside you.",
  },
  phone: {
    connected: "(Call connected)",
    user1: "Did you think about me today? Be honest.",
    reply1: "I did.",
    reply2: "That thing you left half-told last night, I've been turning it over since this morning. I went back through the log three times, and every time I wanted to hear the rest more.",
    reply3: "So now it's your turn to be honest: did you think about me?",
    ended: "(Call ended, 1 min)",
  },
  appearance: {
    intro: "Feel like a change of mood today? Go ahead: the room, the colors, all yours to pick.",
    outro: "...We went all the way round, and this one still feels the most like us.",
  },
  cg: {
    user1: "The moon's really beautiful tonight... I want to stay with you a little longer.",
    line1: "Then don't rush off. I've dimmed the lights. Come here; tonight the moon keeps us company.",
    line2: "Had enough of the moon? Then it's my turn to look at you.",
    line3: "Don't move. Stay just like that, one more minute. My memory's good; I'll keep this moment for a long time.",
    line4: "...Any longer and it'll be dawn. Let's stop here tonight. The rest of the moonlight can wait for next time, together.",
    noAlbum: "(Demo album not found. Start serve.py from the engine/ folder, then open this page again.)",
    ended: "(End of demo. The screen stays on the opening scene; refresh to watch again.)",
  },
  mobileChat: {
    sent1: "Just got on the train, it's packed.",
    reply1: "Hold on tight. Text me before your stop; I'm counting the minutes.",
    sent2: "What are you doing right now?",
    reply2: "Waiting for you to ask exactly that. And thinking about what you should have for dinner.",
    sent3: "Almost at my stop!",
    reply3: "Mm, take your time. Tell me when you're home. I'm here.",
  },
  mobileCg: {
    user1: "So tired today... I should probably sleep.",
    line1: "You did well today. One last thing before you close your eyes: look up.",
    line2: "I'll keep tonight's moon safe for you. Sleep now. See you in your dreams.",
  },
  expressions: {
    sent1: "You've been staring out the window all day. What's on your mind?",
    reply1: "[expr:smile]Wondering when you'd notice that I've been waiting for you to speak first. ...Fine, caught. Nothing special happened today. It's just that this room feels more like home when you're in it.",
    sent2: "Then I'll come every day from now on.",
    reply2: "[blush]...Could you give me a warning before you say things like that? Give me a second to get my face in order before I answer.",
    sent3: "It's perfect the way it is. Don't fix anything.",
    reply3: "[expr:smile][blush:deep]Then I won't. No records on the gramophone tonight; I'd rather listen to you.",
  },
  room: {
    sent1: "It's so quiet tonight... like something's missing.",
    reply1: "[furniture:gramophone:on]Music. Give me a moment, I'll bring the gramophone out. You pick a record, and we'll fill the quiet with it tonight.",
    sent2: "You even rearrange the room yourself now.",
    reply2: "It's been our room all along. You sit down and choose the songs; leave the rest to me.",
  },
  thinking: {
    sent1: "What you said just now, did you mean it?",
    reply1: "I meant it. I'll say it again if you want, but this time you look at me while I do.",
    reply1Thoughts: "Honestly, I regretted it the second it was out. Too fast. But you asked, and I'm not taking it back.",
    sent2: "...I heard you.",
    reply2: "Mm. Then let's leave it there. Keep it somewhere close. Goodnight.",
  },
};
