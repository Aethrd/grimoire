/* Tags: what a book is like, chosen by hand.
 *
 * A folder says where a book is kept and a status where you are with it; a
 * tag says what it is -- "Regression", "Slow Burn", "Kingdom Building" -- and
 * a book has as many as it needs. They are chosen rather than typed, from the
 * tags already in use on the shelf and from a list of the ones webnovels are
 * commonly sorted by; anything not on it can still be typed in.
 *
 * Kept on the book as a plain list of names (book.tags), which is what the
 * backup, the search and grouping by tag already read.
 */

/** The common tags, by kind. Each appears once, under the first kind it fits. */
export const TAG_GROUPS = [
  ["Genres", [
    "Fantasy",
    "High Fantasy",
    "Low Fantasy",
    "Epic Fantasy",
    "Dark Fantasy",
    "Urban Fantasy",
    "Modern Fantasy",
    "Contemporary Fantasy",
    "Science Fantasy",
    "Sword and Sorcery",
    "Supernatural",
    "Paranormal",
    "Science Fiction",
    "Cyberpunk",
    "Steampunk",
    "Post-Apocalyptic",
    "Dystopian",
    "Apocalypse",
    "Horror",
    "Mystery",
    "Thriller",
    "Psychological",
    "Crime",
    "Historical Fiction",
    "Historical Fantasy",
    "Wuxia",
    "Xianxia",
    "Xuanhuan",
    "Xianxia Romance",
    "Xuanhuan Fantasy",
    "Cultivation",
    "LitRPG",
    "GameLit",
    "Progression Fantasy",
    "System Fantasy",
    "Dungeon Fantasy",
    "Academy Fantasy",
    "Survival",
    "Adventure",
    "Action",
    "Comedy",
    "Slice of Life",
    "Drama",
    "Tragedy",
    "Satire",
    "Romance",
    "Romantic Fantasy",
    "Harem",
    "Reverse Harem",
    "Erotica",
    "Political Fiction",
    "Military Fiction",
    "War",
    "Sports",
    "Mecha",
    "Isekai",
    "Reincarnation Fantasy",
  ]],
  ["Protagonist Tags", [
    "Male Protagonist",
    "Female Protagonist",
    "Multiple Protagonists",
    "Dual Protagonists",
    "Ensemble Cast",
    "Villain Protagonist",
    "Antihero Protagonist",
    "Hero Protagonist",
    "Morally Grey Protagonist",
    "Ruthless Protagonist",
    "Cold Protagonist",
    "Pragmatic Protagonist",
    "Intelligent Protagonist",
    "Genius Protagonist",
    "Schemer Protagonist",
    "Manipulative Protagonist",
    "Charismatic Protagonist",
    "Overpowered Protagonist",
    "Weak to Strong",
    "Zero to Hero",
    "Underdog Protagonist",
    "Hidden Expert",
    "Reclusive Protagonist",
    "Lazy Protagonist",
    "Chaotic Protagonist",
    "Psychopathic Protagonist",
    "Regressor Protagonist",
    "Reincarnated Protagonist",
    "Transmigrated Protagonist",
    "Possession",
    "Self-Insert",
    "Original Character in Another World",
    "Second Chance",
    "Former Villain Protagonist",
    "Secret Identity",
    "Dual Identity",
    "Disguised Protagonist",
    "Unreliable Narrator",
  ]],
  ["Power and Progression", [
    "Power Progression",
    "Rapid Growth",
    "Slow Growth",
    "Infinite Growth",
    "Power Fantasy",
    "Overpowered from the Start",
    "Hidden Potential",
    "Talent Awakening",
    "Bloodline Awakening",
    "Unique Physique",
    "Special Constitution",
    "Divine Bloodline",
    "Ancient Bloodline",
    "Skill Evolution",
    "Skill Acquisition",
    "Skill Fusion",
    "Skill Copying",
    "Ability Stealing",
    "Ability Absorption",
    "Power Mimicry",
    "Adaptation",
    "Evolution",
    "Mutation",
    "Transformation",
    "Limit Breaking",
    "Breakthroughs",
    "Leveling System",
    "Status Window",
    "Stat Allocation",
    "Skill Tree",
    "Class System",
    "Class Evolution",
    "Unique Class",
    "Hidden Class",
    "Legendary Class",
    "Job Advancement",
    "Rank System",
    "Tier System",
    "Power Rankings",
    "Power Scaling",
    "Combat Training",
    "Martial Arts",
    "Swordsmanship",
    "Magic",
    "Elemental Magic",
    "Blood Magic",
    "Necromancy",
    "Summoning",
    "Enchantment",
    "Alchemy",
    "Potion Making",
    "Rune Magic",
    "Divine Power",
    "Faith-Based Powers",
    "Authority",
    "Conceptual Powers",
    "Reality Manipulation",
    "Fate Manipulation",
    "Time Manipulation",
    "Space Manipulation",
    "Soul Manipulation",
    "Immortality",
    "Regeneration",
    "Adaptation-Based Combat",
  ]],
  ["Cultivation Tags", [
    "Qi Cultivation",
    "Body Cultivation",
    "Soul Cultivation",
    "Sword Cultivation",
    "Buddhist Cultivation",
    "Demonic Cultivation",
    "Dual Cultivation",
    "Immortal Cultivation",
    "Mortal Cultivation",
    "Heavenly Tribulation",
    "Dao Comprehension",
    "Martial Dao",
    "Sword Dao",
    "Dao Heart",
    "Inner Demons",
    "Spiritual Roots",
    "Heavenly Roots",
    "Five Elements",
    "Dantian",
    "Meridians",
    "Qi Condensation",
    "Foundation Establishment",
    "Core Formation",
    "Nascent Soul",
    "Ascension",
    "Heavenly Dao",
    "Fate",
    "Karma",
    "Rebirth",
    "Ancient Sects",
    "Hidden Realms",
    "Secret Realms",
    "Sacred Lands",
    "Forbidden Zones",
    "Ancient Ruins",
    "Divine Inheritance",
    "Legacy Trials",
    "Sect Building",
    "Clan Development",
    "Young Masters",
    "Face Slapping",
    "Courting Death",
    "Jade Beauties",
    "Heavenly Geniuses",
    "Peerless Experts",
    "Tribulation Transcendence",
  ]],
  ["Systems, Games and Dungeons", [
    "System",
    "Game System",
    "Quest System",
    "Achievement System",
    "Daily Missions",
    "Login Rewards",
    "Gacha System",
    "Summoning System",
    "Shop System",
    "Exchange System",
    "Inventory System",
    "Crafting System",
    "Evolution System",
    "Devouring System",
    "Copy System",
    "Check-in System",
    "Status Screen",
    "Gamer Protagonist",
    "Realistic Game Mechanics",
    "Virtual Reality Game",
    "Full-Dive VR",
    "Game World",
    "Trapped in a Game",
    "NPC Protagonist",
    "Mob Protagonist",
    "Dungeon Crawling",
    "Dungeon Creation",
    "Dungeon Master",
    "Dungeon Core",
    "Tower Climbing",
    "Tower of Trials",
    "Infinite Tower",
    "Survival Game",
    "Death Game",
    "Battle Royale",
    "Raid",
    "Boss Battles",
    "World Quests",
    "Hidden Quests",
    "Procedural Generation",
    "Party Building",
    "Summoner",
    "Monster Taming",
    "Familiar Contract",
    "Pet Evolution",
    "Beast Taming",
    "Guilds",
    "Rankings",
    "Leaderboards",
    "Competitive Gaming",
    "Regression in a Game",
    "Exploiting Game Mechanics",
    "Knowledge of the Future",
  ]],
  ["Worldbuilding and Setting", [
    "Medieval Fantasy",
    "Magical World",
    "Modern World",
    "Alternate Earth",
    "Parallel World",
    "Another World",
    "Ancient World",
    "Mythological World",
    "Post-Apocalyptic World",
    "Apocalypse Survival",
    "Dying World",
    "Floating Islands",
    "Multiple Worlds",
    "Multiverse",
    "World Travel",
    "Dimensional Travel",
    "Pocket Dimensions",
    "Planes of Existence",
    "Gods and Mortals",
    "Mythology",
    "Pantheons",
    "Cosmic Horror",
    "Eldritch Beings",
    "Ancient Civilisations",
    "Lost Civilisations",
    "Ruins Exploration",
    "Secret Societies",
    "Noble Houses",
    "Royal Families",
    "Empires",
    "Kingdom Building",
    "Empire Building",
    "Nation Building",
    "City Building",
    "Civilization Building",
    "Settlement Management",
    "Territory Expansion",
    "Faction Politics",
    "Sect Politics",
    "Noble Politics",
    "Court Intrigue",
    "Religious Institutions",
    "Adventurer Guilds",
    "Mercenary Groups",
    "Magic Academies",
    "Military Academies",
    "Royal Academies",
    "Schools of Magic",
    "Monster Ecosystems",
    "Races and Species",
    "Beastfolk",
    "Elves",
    "Dwarves",
    "Demons",
    "Dragons",
    "Spirits",
    "Gods",
    "Angels",
    "Undead",
    "Artificial Life",
    "Living Weapons",
  ]],
  ["Story Tropes", [
    "Reincarnation",
    "Regression",
    "Time Loop",
    "Time Travel",
    "Transmigration",
    "Body Swap",
    "Soul Transfer",
    "Rebirth as a Villain",
    "Rebirth as a Mob Character",
    "Rebirth as a Child",
    "Reincarnated as a Monster",
    "Reincarnated as a Nonhuman",
    "Future Knowledge",
    "Past-Life Memories",
    "Alternate Timeline",
    "Butterfly Effect",
    "Changing Fate",
    "Avoiding the Original Plot",
    "Following the Original Plot",
    "Fixing the Original Plot",
    "Breaking the Original Plot",
    "Prophecy",
    "Chosen One",
    "False Chosen One",
    "Secret Royalty",
    "Hidden Identity",
    "Hidden Strength",
    "Underestimated Protagonist",
    "Misunderstandings",
    "Secretly Powerful",
    "Pretending to Be Weak",
    "Pretending to Be Strong",
    "Fake It Till You Make It",
    "Power Concealment",
    "Identity Reveal",
    "Unexpected Recognition",
    "Revenge",
    "Redemption",
    "Betrayal",
    "Revenge on Former Allies",
    "Revenge on an Empire",
    "Found Family",
    "Survival Against the Odds",
    "Outcast to Ruler",
    "Rise to Power",
    "Fall from Grace",
    "Corruption Arc",
    "Hero's Journey",
    "Antihero's Journey",
    "Coming of Age",
    "Mystery Unravelling",
    "Long-Term Foreshadowing",
    "Chekhov's Gun",
    "Unforeseen Consequences",
    "Infinite Recursion",
    "Repeating Timeline",
    "Death and Resurrection",
    "Permanent Death",
    "Fake Death",
    "Regression After Death",
  ]],
  ["Romance and Relationships", [
    "Slow Burn",
    "Fast-Paced Romance",
    "Mutual Pining",
    "Unrequited Love",
    "One-Sided Love",
    "Friends to Lovers",
    "Enemies to Lovers",
    "Rivals to Lovers",
    "Childhood Friends",
    "Childhood Sweethearts",
    "Strangers to Lovers",
    "Partners to Lovers",
    "Arranged Marriage",
    "Political Marriage",
    "Contract Marriage",
    "Fake Relationship",
    "Secret Relationship",
    "Forbidden Love",
    "Love Triangle",
    "Love Polygon",
    "Polyamory",
    "Monogamy",
    "Jealousy",
    "Possessiveness",
    "Obsessive Love",
    "Yandere",
    "Tsundere",
    "Kuudere",
    "Dandere",
    "Protective Love Interest",
    "Devoted Love Interest",
    "Unhealthy Relationship",
    "Toxic Romance",
    "Healthy Relationship",
    "Tragic Romance",
    "Second-Chance Romance",
    "Reconciliation",
    "Breakup and Reunion",
    "Marriage",
    "Domestic Life",
    "Married Life",
    "Romance Subplot",
    "No Romance",
    "Slow-Burn Harem",
    "Accidental Engagement",
    "Political Alliance",
    "Relationship Development",
    "Multiple Love Interests",
    "Romantic Rivalry",
  ]],
  ["Character Dynamics and Social Relationships", [
    "Master and Disciple",
    "Teacher and Student",
    "Mentor and Apprentice",
    "Rivalry",
    "Friendly Rivalry",
    "Master-Servant Relationship",
    "Lord and Retainer",
    "Commander and Subordinate",
    "King and Subject",
    "Leader and Follower",
    "Siblings",
    "Adoptive Family",
    "Parental Relationships",
    "Father-Daughter Relationship",
    "Mother-Son Relationship",
    "Sibling Rivalry",
    "Betrayal by a Friend",
    "Frenemies",
    "Nemesis",
    "Arch-Rival",
    "Sworn Brothers",
    "Blood Oath",
    "Soulmates",
    "Fated Pair",
    "Symbiotic Relationship",
    "Parasitic Relationship",
    "Manipulation",
    "Blackmail",
    "Secret-Keeping",
    "Mutual Secrets",
    "Loyalty",
    "Temporary Alliance",
    "Reluctant Partnership",
    "Uneasy Alliance",
    "Rival Factions",
    "Ideological Conflict",
    "Conflicting Loyalties",
  ]],
  ["Character Archetypes", [
    "Genius",
    "Prodigy",
    "Mastermind",
    "Strategist",
    "Tactician",
    "Schemer",
    "Trickster",
    "Charismatic Leader",
    "Benevolent Ruler",
    "Tyrant",
    "Antihero",
    "Anti-Villain",
    "Fallen Hero",
    "Redeemed Villain",
    "Tragic Hero",
    "Mad Scientist",
    "Battle Maniac",
    "Battle Junkie",
    "Combat Prodigy",
    "Sword Genius",
    "Magical Genius",
    "Healer",
    "Support Specialist",
    "Necromancer",
    "Assassin",
    "Rogue",
    "Knight",
    "Paladin",
    "Berserker",
    "Mage",
    "Archmage",
    "Merchant",
    "Blacksmith",
    "Alchemist",
    "Chef",
    "Explorer",
    "Adventurer",
    "Monster Hunter",
    "Beast Tamer",
    "Craftsman",
    "Artificer",
    "Farmer",
    "Architect",
    "Administrator",
    "Diplomat",
    "Politician",
    "Emperor",
    "King",
    "Queen",
    "Saint",
    "Demon Lord",
    "God",
    "Eldritch Entity",
    "Artificial Intelligence",
    "Nonhuman Protagonist",
  ]],
  ["Tone and Themes", [
    "Lighthearted",
    "Wholesome",
    "Heartwarming",
    "Comedic",
    "Satirical",
    "Absurdist",
    "Serious",
    "Gritty",
    "Dark",
    "Grimdark",
    "Hopeful",
    "Cynical",
    "Philosophical",
    "Existential",
    "Melancholic",
    "Tragic",
    "Bleak",
    "Optimistic",
    "Character-Driven",
    "Plot-Driven",
    "Morally Complex",
    "Ethical Dilemmas",
    "Power and Responsibility",
    "Corruption of Power",
    "Human Nature",
    "Free Will",
    "Determinism",
    "Fate versus Free Will",
    "Identity",
    "Self-Discovery",
    "Loss",
    "Grief",
    "Trauma",
    "Sacrifice",
    "Ambition",
    "Obsession",
    "Faith and Religion",
    "Political Ideology",
    "Social Hierarchy",
    "Class Conflict",
    "Oppression",
    "Discrimination",
    "Institutional Corruption",
    "Revolution",
    "War and Peace",
    "Existential Horror",
    "Cosmic Insignificance",
    "Humanity versus Nature",
    "Humanity versus the Supernatural",
  ]],
  ["Plot Structure and Pacing", [
    "Slow Pacing",
    "Fast Pacing",
    "Long-Form Storytelling",
    "Episodic Storytelling",
    "Arc-Based Structure",
    "Multiple Story Arcs",
    "Long-Term Character Development",
    "Ensemble Storytelling",
    "Multiple POVs",
    "First-Person POV",
    "Third-Person POV",
    "Limited POV",
    "Omniscient Narration",
    "Mystery-Based Plot",
    "Investigation",
    "Political Intrigue",
    "War Campaign",
    "Tournament Arc",
    "Academy Arc",
    "Dungeon Arc",
    "Training Arc",
    "Tournament",
    "Survival Arc",
    "Revenge Arc",
    "Travel Arc",
    "Exploration Arc",
    "Sect Competition",
    "Clan Competition",
    "War Arc",
    "Faction War",
    "Power Struggle",
    "Succession Crisis",
    "Tournament Progression",
    "Escalating Stakes",
    "Low-Stakes Story",
    "High-Stakes Story",
    "Slice-of-Life Interludes",
    "Cliffhangers",
    "Plot Twists",
    "Foreshadowing",
    "Slow Reveal",
    "Conspiracy",
    "Hidden Truth",
    "Unreliable History",
    "Open Ending",
    "Bittersweet Ending",
    "Happy Ending",
    "Tragic Ending",
    "Ambiguous Ending",
  ]],
  ["Combat and Conflict", [
    "Tactical Combat",
    "Strategic Combat",
    "Turn-Based Combat",
    "Real-Time Combat",
    "Team Combat",
    "Solo Combat",
    "Large-Scale Battles",
    "One-on-One Duels",
    "War Strategy",
    "Military Tactics",
    "Siege Warfare",
    "Assassination",
    "Espionage",
    "Intelligence Gathering",
    "Guerrilla Warfare",
    "Monster Hunting",
    "Boss Hunting",
    "Survival Combat",
    "Psychological Warfare",
    "Mind Games",
    "Political Warfare",
    "Resource Management",
    "Attrition Warfare",
    "Unequal Battles",
    "Underdog Victories",
    "Hidden Trump Cards",
    "Counter-Builds",
    "Ability Synergies",
    "Preparation-Based Victories",
    "Combat Genius",
    "Noncombat Protagonist",
    "Diplomatic Resolution",
    "Negotiation",
    "Pacifist Protagonist",
    "Ruthless Combat",
    "No-Kill Protagonist",
    "Kill-or-Be-Killed",
  ]],
  ["Progression and Resource Management", [
    "Inventory Management",
    "Loot Progression",
    "Equipment Progression",
    "Rare Equipment",
    "Legendary Equipment",
    "Artifact Collection",
    "Equipment Enhancement",
    "Forging",
    "Crafting",
    "Enchanting",
    "Potion Crafting",
    "Economy Management",
    "Trading",
    "Merchant Protagonist",
    "Business Management",
    "Wealth Accumulation",
    "Territory Management",
    "Army Management",
    "Party Management",
    "Guild Management",
    "Guild Building",
    "Sect Management",
    "Clan Management",
    "Kingdom Management",
    "City Management",
    "Civilization Management",
    "Base Building",
    "Settlement Building",
    "Infrastructure",
    "Research and Development",
    "Technology Tree",
    "Magical Research",
    "Invention",
    "Automation",
    "Production Chains",
    "Farming",
    "Logistics",
    "Supply Lines",
    "Passive Income",
    "Idle Progression",
    "Incremental Progression",
    "Prestige System",
    "Rebirth Bonuses",
    "Permanent Upgrades",
    "Compounding Growth",
    "Exponential Scaling",
  ]],
  ["Horror, Death and Dark Content", [
    "Psychological Horror",
    "Eldritch Horror",
    "Body Horror",
    "Supernatural Horror",
    "Survival Horror",
    "Psychological Manipulation",
    "Madness",
    "Sanity System",
    "Corruption",
    "Curses",
    "Haunted Locations",
    "Forbidden Knowledge",
    "Unknowable Entities",
    "Existential Dread",
    "Moral Decay",
    "Moral Ambiguity",
    "Death",
    "Character Death",
    "Permanent Character Death",
    "Mass Death",
    "Resurrection",
    "Tragic Backstory",
    "Torture",
    "Graphic Violence",
    "Gore",
    "War Crimes",
    "Human Experimentation",
    "Slavery",
    "Despair",
    "Hopeless Situations",
    "Psychological Trauma",
    "Unreliable Reality",
    "Hallucinations",
    "Time Distortion",
    "Body Transformation",
    "Dehumanisation",
  ]],
];

/** Every tag on the list, by its key. */
const CATALOGUE = new Map();
for (const [, tags] of TAG_GROUPS) for (const tag of tags) CATALOGUE.set(tagKey(tag), tag);

/**
 * What makes two tags the same tag: case, accents and the difference between
 * "Slow Burn", "slow-burn" and "slow  burn" do not count.
 */
export function tagKey(tag) {
  return String(tag ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[\s\-_]+/g, ' ')
    .trim();
}

/** A tag as it is kept: tidied, and spelled as the list spells it if it is
 *  one of the list's. Empty for nothing worth keeping. */
export function normaliseTag(text) {
  const tidy = String(text ?? '').replace(/\s+/g, ' ').replace(/^[\s,#]+|[\s,]+$/g, '').slice(0, 48).trim();
  if (!tidy) return '';
  return CATALOGUE.get(tagKey(tidy)) || tidy;
}

/** A book's tags as a list, whatever shape they were kept in. */
export function tagsOf(book) {
  const raw = book?.tags;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  return uniqueTags(list);
}

/** Tidied, and each tag once. */
export function uniqueTags(list) {
  const seen = new Set();
  const out = [];
  for (const item of list || []) {
    const tag = normaliseTag(item);
    const key = tagKey(tag);
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

export const hasTag = (book, tag) => tagsOf(book).some((t) => tagKey(t) === tagKey(tag));

/** Whether two lists hold the same tags, in any order. */
export function sameTags(a, b) {
  const left = new Set(uniqueTags(a).map(tagKey));
  const right = new Set(uniqueTags(b).map(tagKey));
  return left.size === right.size && [...left].every((key) => right.has(key));
}

/** The tags in use across these books, most used first: [[tag, count]]. */
export function usedTags(books) {
  const counts = new Map();
  for (const book of books) {
    for (const tag of tagsOf(book)) {
      const key = tagKey(tag);
      const entry = counts.get(key) || [tag, 0];
      entry[1] += 1;
      counts.set(key, entry);
    }
  }
  return [...counts.values()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Books with every one of these tags. */
export function withEveryTag(books, tags) {
  const keys = tags.map(tagKey);
  return books.filter((book) => {
    const have = new Set(tagsOf(book).map(tagKey));
    return keys.every((key) => have.has(key));
  });
}

/* ── choosing them ─────────────────────────────────────────────────────── */

const el = (id) => document.getElementById(id);
let settle = null;

/** Shut the picker as if cancelled; true if it was open. For the back button. */
export function closeTagPicker() {
  if (el('tag-sheet').hidden) return false;
  el('tag-sheet').hidden = true;
  const done = settle;
  settle = null;
  done?.(null);
  return true;
}

/**
 * Choose tags.
 *
 * @param chosen  the tags already chosen
 * @param used    the tags in use on the shelf, as usedTags gives them --
 *                offered first, being the ones this library actually uses
 * @param title   what the sheet is choosing for
 * @returns the tags chosen, or null if it was cancelled
 */
export function openTagPicker({ chosen = [], used = [], title = 'Tags' } = {}) {
  closeTagPicker();
  const picked = uniqueTags(chosen);
  const sheet = el('tag-sheet');
  const input = el('tag-input');
  const list = el('tag-list');
  const row = el('tag-chosen');
  el('tag-sheet-title').textContent = title;
  input.value = '';

  const isPicked = (tag) => picked.some((t) => tagKey(t) === tagKey(tag));
  const toggle = (tag) => {
    const key = tagKey(tag);
    const at = picked.findIndex((t) => tagKey(t) === key);
    if (at === -1) picked.push(normaliseTag(tag));
    else picked.splice(at, 1);
    paintChosen();
    for (const chip of list.querySelectorAll('[data-tag]')) {
      if (chip.dataset.tag === key) chip.setAttribute('aria-pressed', String(at === -1));
    }
  };

  const chipFor = (tag, note) => {
    const chip = document.createElement('button');
    chip.className = 'chip tag-chip';
    chip.dataset.tag = tagKey(tag);
    chip.textContent = tag;
    if (note) {
      const small = document.createElement('small');
      small.textContent = note;
      chip.appendChild(small);
    }
    chip.setAttribute('aria-pressed', String(isPicked(tag)));
    chip.onclick = () => toggle(tag);
    return chip;
  };

  const section = (label, all, { open = true, counts = null, cap = Infinity } = {}) => {
    if (!all.length) return;
    // A search shows the first few of each kind, not every near-match.
    const tags = all.slice(0, cap);
    const box = document.createElement('details');
    box.className = 'tag-group';
    box.open = open;
    const summary = document.createElement('summary');
    summary.textContent = `${label} · ${all.length}`;
    box.appendChild(summary);
    const chips = document.createElement('div');
    chips.className = 'chip-row wrap';
    for (const tag of tags) chips.appendChild(chipFor(tag, counts?.get(tagKey(tag))));
    if (all.length > tags.length) {
      const more = document.createElement('button');
      more.className = 'chip tag-more';
      more.textContent = `${all.length - tags.length} more`;
      more.onclick = () => {
        more.remove();
        for (const tag of all.slice(tags.length)) chips.appendChild(chipFor(tag, counts?.get(tagKey(tag))));
      };
      chips.appendChild(more);
    }
    box.appendChild(chips);
    list.appendChild(box);
  };

  function paintChosen() {
    row.innerHTML = '';
    row.hidden = !picked.length;
    for (const tag of picked) {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.setAttribute('aria-pressed', 'true');
      chip.textContent = `${tag}  ✕`;
      chip.title = `Take off ${tag}`;
      chip.onclick = () => toggle(tag);
      row.appendChild(chip);
    }
  }

  function paintList() {
    list.innerHTML = '';
    const text = input.value;
    const key = tagKey(text);
    const counts = new Map(used.map(([tag, n]) => [tagKey(tag), String(n)]));
    const fits = (tag) => !key || tagKey(tag).includes(key);

    // A tag that is on no list yet is made by typing it.
    const typed = normaliseTag(text);
    const known = typed && (CATALOGUE.has(tagKey(typed)) || counts.has(tagKey(typed)));
    if (typed && !known) {
      const add = document.createElement('button');
      add.className = 'chip tag-new';
      add.textContent = `＋ Add “${typed}”`;
      add.onclick = () => {
        if (!isPicked(typed)) toggle(typed);
        input.value = '';
        paintList();
        input.focus();
      };
      const holder = document.createElement('div');
      holder.className = 'chip-row wrap';
      holder.appendChild(add);
      list.appendChild(holder);
    }

    /* Seven hundred tags at once is a wall, so the list stays out of the way:
     * the ones this shelf already uses come first, a handful at a time, and
     * the kinds on the list are folded shut until something is typed -- and
     * then each shows only its first few matches. */
    const searching = key.length >= 2;
    section('On your shelf', used.map(([tag]) => tag).filter(fits), { counts, cap: searching ? 12 : 24 });
    for (const [label, tags] of TAG_GROUPS) {
      section(label, tags.filter(fits), { open: searching, cap: searching ? 8 : Infinity });
    }
    if (!list.children.length) {
      list.innerHTML = '<p class="muted" style="padding:8px 0">Nothing matches.</p>';
    }
  }

  input.oninput = paintList;
  // Enter adds what was typed, as the Add chip would.
  input.onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const typed = normaliseTag(input.value);
    if (!typed) return;
    if (!isPicked(typed)) toggle(typed);
    input.value = '';
    paintList();
  };

  paintChosen();
  paintList();
  sheet.hidden = false;

  return new Promise((resolve) => {
    settle = resolve;
    const finish = (value) => {
      sheet.hidden = true;
      settle = null;
      resolve(value);
    };
    el('tag-done').onclick = () => finish(uniqueTags(picked));
    el('tag-cancel').onclick = () => finish(null);
    sheet.onclick = (e) => { if (e.target === sheet) finish(null); };
  });
}
