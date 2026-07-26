/**
 * Stopwords for lesson relevance scoring (issue #669).
 *
 * Two groups, both load-bearing:
 *
 *  1. ENGLISH FUNCTION WORDS of 4+ characters. The tokenizer already drops
 *     words of 3 or fewer, so `the`/`and`/`for`/`not` never reach here — the
 *     words that mattered were exactly the 4+ ones that read as technical but
 *     are not: `with`, `never`, `must`, `should`, `always`, `verify` is NOT
 *     here (it is genuinely discriminative in this corpus), `before`, `every`.
 *     Three of these were enough to clear the old absolute floor of 6.
 *
 *  2. LESSON-CARD TEMPLATE WORDS. `MemoryWriter.writeLessonCard` renders every
 *     card as `**Why it failed:** … **What happened:** … **Task context:** …`,
 *     so `why`/`what`/`failed`/`happened`/`task`/`context`/`lesson` appear in
 *     100% of cards and carry zero discriminative power. Corpus-frequency
 *     demotion would find them too, but only once several cards exist; listing
 *     them makes the model correct from the first card.
 *
 * NOT stopwords, deliberately: `agent`, `signal`, `consensus`, `dispatch`,
 * `path`, `finding`, `worktree`, `verify`, `branch`. These are the project's
 * domain vocabulary. They ARE informative — a task about signals should recall
 * a signal lesson. Their ubiquity within the lesson corpus is handled by the
 * document-frequency weight in lesson-scoring.ts, which is corpus-relative and
 * self-tuning, rather than by a hand-maintained list that would go stale.
 */

const ENGLISH_FUNCTION_WORDS = `
about above across after again against alike almost alone along already also
although always among another anyone anything anywhere apart around aside away
back because been before behind being below beside besides better between
beyond both bring brought came cannot come comes coming could couldn does
doesn doing done down during each either else elsewhere enough even ever every
everyone everything everywhere except fewer five follow following four from
further gave gets getting give given gives goes going gone half hand hardly
have haven having hence here herself himself hold however indeed inside instead
into itself just keep kept kind knew know known last late later least leave
leaving left less lest like likely little long look looking lots made make
makes making many maybe mean means meant might mine more moreover most mostly
much must myself near nearly need needs neither never nevertheless next nine
none nonetheless nothing notice once only onto other others otherwise ought
ours ourselves outside over overall particular past perhaps please point
possible probably quite rather really regarding right said same saying says
second seem seems seen sent seven several shall should shouldn show shown side
simply since sixth small some somehow someone something sometimes somewhat
somewhere soon sort still such sure take taken takes taking tell tells than
that their theirs them themselves then there thereby therefore these they thing
things think third this those though three through throughout thus together
took toward towards tried tries turn twice under unless until upon used uses
using usually very want wants well went were whatever whenever where whereas
whether which while whilst whole whom whose will with within without wonder
would wouldn your yours yourself yourselves
`;

/**
 * Words the lesson-card template puts in EVERY card. `time`/`times`,
 * `first`/`full`/`good`/`great`/`high`/`large` are generic-prose words that
 * behaved identically to function words in the off-domain measurements.
 */
const TEMPLATE_AND_GENERIC_WORDS = `
what when where why task context lesson failed fails happens happening happened
time times first full good great high large real true part place work works
case cases sends provide put fact find finds
`;

export const LESSON_STOPWORDS: ReadonlySet<string> = new Set(
  `${ENGLISH_FUNCTION_WORDS} ${TEMPLATE_AND_GENERIC_WORDS}`
    .split(/\s+/)
    .filter(w => w.length > 3),
);
