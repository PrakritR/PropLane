/**
 * The PropLane blog: typed posts, one file, no CMS.
 *
 * Source of truth for every number is the fact sheet the posts were written
 * from. Rules the posts keep (and `tests/unit/blog-posts.test.ts` pins):
 *  - a number is quoted as its source states it, and the sentence names the
 *    source; a vendor survey is called a vendor survey;
 *  - one source per claim; every stat tile points at a source with an https URL;
 *  - the 2021 Rental Housing Finance Survey and the 2024 one are never blended
 *    (these posts use 2021 only);
 *  - no figure is attributed to NARPM that NARPM did not publish;
 *  - at most one sentence names PropLane, and it links to `/`.
 *
 * Inline links inside a paragraph use `[label](/path)`; `renderInline`
 * (src/components/marketing/blog/inline-text.tsx) is the only reader.
 */

export type BlogStat = {
  /** The figure as the source states it, e.g. "42%" or "$1,800". */
  value: string;
  label: string;
  /** Index into the post's `sources`. */
  sourceIndex: number;
};

export type BlogSection = {
  heading?: string;
  paragraphs: string[];
};

export type BlogSource = {
  title: string;
  publisher: string;
  year: number;
  url: string;
};

export type BlogPost = {
  slug: string;
  title: string;
  /** Meta description. */
  description: string;
  /** ISO date, yyyy-mm-dd. */
  date: string;
  readMinutes: number;
  category: string;
  stats: BlogStat[];
  sections: BlogSection[];
  sources: BlogSource[];
};

const WEEK_OF_A_MANAGER: BlogPost = {
  slug: "where-a-property-managers-week-goes",
  title: "Where a property manager's week actually goes",
  description:
    "Two industry surveys and one federal wage figure, put together: how much of a manager's week is routine or reactive work, what an hour of it costs, and where to start.",
  date: "2026-10-12",
  readMinutes: 5,
  category: "Operations",
  stats: [
    { value: "42%", label: "of the week on routine operational work", sourceIndex: 0 },
    { value: "24%", label: "of the week on reactive tasks", sourceIndex: 0 },
    { value: "15 hours", label: "a week that could be optimized through technology, on average", sourceIndex: 1 },
    { value: "$33.65", label: "median hourly pay for property managers, May 2025", sourceIndex: 2 },
  ],
  sections: [
    {
      paragraphs: [
        "Ask a property manager what the job is and you will hear about residents, repairs and rent. Ask where Tuesday went and you will hear about something else: the paperwork, the follow-up text, the third email to find out whether the vendor is coming. This post puts numbers on that gap, using the best public figures available, and is careful about what those figures can and cannot say.",
        "A warning up front. Nearly all the time data on property management comes from surveys of operators, most of them running far more than ten units. We found no good national figure for how many hours a week a landlord with five or ten units spends on the work. Treat what follows as the shape of the problem, not a measurement of yours.",
      ],
    },
    {
      heading: "Two-thirds of the week is routine or reactive",
      paragraphs: [
        "The National Apartment Association and AppFolio surveyed nearly 2,000 real estate industry professionals in July and August 2025 for their 2025 Performance Ecosystem Report. As reported by Multifamily Executive, the report found that “42% of the week goes to routine operational work, such as paperwork, data entry, and administration. 24% goes to reactive tasks, such as troubleshooting and responding to urgent requests.”",
        "Add the two: 42% + 24% = 66%. That leaves about one-third of the week, per the same report, for higher-value work: the pricing decisions, the owner conversations, the walk-through that catches a problem early. The association's chief executive summed it up as “the largest threat to property performance isn't demand, it's our operational strain.”",
        "Two cautions. The survey was co-run by a trade association and a software vendor, so it is a survey with a stake in the answer. And its respondents are mostly multifamily operators, not people who manage a handful of houses.",
      ],
    },
    {
      heading: "How many of those hours could be handed off",
      paragraphs: [
        "AppFolio's Property Manager Hiring and Retention Report asked a related question. It is a vendor survey of more than 2,300 employees of property management companies with 50 or more residential units, fielded in April 2023. AppFolio reported that “nearly one-third of a typical workweek (up to 15 hours per week) could be optimized or streamlined through technology.” The average was 15 hours a week, and 18 hours at companies with 10,000 or more units. In the same survey, leadership (69%) and staff (55%) said they “wish they had more time to focus on higher-value tasks.”",
        "Read that as AppFolio's survey of its own industry. These are employees' estimates of time that could be saved, not time measured with a stopwatch, and the companies are larger than a typical small portfolio. It is a useful order of magnitude, not a promise.",
      ],
    },
    {
      heading: "Putting a dollar figure on 15 hours",
      paragraphs: [
        "The Bureau of Labor Statistics supplies a plain wage for the occupation. Its Occupational Outlook Handbook lists median pay for property, real estate, and community association managers at $69,990 a year, or $33.65 an hour, as of May 2025, across about 460,400 jobs. The same page says the duties include “making certain that rent is collected” and that managers “may need to respond to emergencies during off-duty hours.”",
        "Here is the arithmetic, with every input cited above. Fifteen hours at $33.65 is 15 × 33.65 = $504.75 a week. Over 52 weeks, 504.75 × 52 = $26,247 a year.",
        "That is a rough estimate, and it can be wrong in both directions. The wage is a national median across all managers and leaves out benefits, payroll tax and overhead, which would push the figure up. The 15 hours is a self-reported estimate of what could be saved, and nobody saves all of it, which would push the figure down. If you manage your own units, the hours are yours and the wage is whatever you would earn with them elsewhere.",
      ],
    },
    {
      heading: "Contractor coordination, counted at one property",
      paragraphs: [
        "One of the few places where hours were counted is a case study that the National Apartment Association reproduces in its Apartment Turnover guidance, written by the vendor Valet Living, at a single 300-unit community in Dallas. It counted “15 hours per week spent on contractor management (emails, text messages, phone calls, meetings, access to homes, etc.)” for a 16-week peak season, and 10 hours a week for the other 36 weeks. At $27 an hour, the case study valued that at $16,200 a year.",
        "The math holds: 15 × 16 = 240 hours, 10 × 36 = 360 hours, 600 hours in all, and 600 × $27 = $16,200. It is one property and a vendor's own case study, so it illustrates the shape of the cost and not an average. The shape is the point: none of it is difficult, all of it is constant. It is emails, texts, calls and getting someone into a unit.",
      ],
    },
    {
      heading: "What to do about it",
      paragraphs: [
        "You will not fix the whole week, so pick the parts that repeat.",
        "Track one week. For five working days, write down what you did in fifteen-minute blocks and tag each block as routine, reactive, or work you would pay yourself to do. Your split will not match 42%, 24% and one-third. That is fine; the point is to know yours.",
        "Price your own hour. If one round of arranging a repair takes forty minutes of messages and you value your time at the BLS median of $33.65, that round costs you about $22 (40 ÷ 60 × 33.65 = 22.43) before the plumber is paid.",
        "Batch the reactive work. Pick two fixed times a day to answer non-urgent messages, and write standing replies for the five questions you answer most often.",
        "Then look at tools. Anything that drafts the repeat messages for you is worth a trial if it saves even an hour a week: at $33.65, an hour a week is about $1,750 a year (33.65 × 52 = 1,749.80). If you want one to try, [PropLane](/) drafts those messages for a manager to approve.",
      ],
    },
  ],
  sources: [
    {
      title: "2025 Performance Ecosystem Report, as reported by Multifamily Executive",
      publisher: "National Apartment Association and AppFolio",
      year: 2025,
      url: "https://www.multifamilyexecutive.com/property-management/report-naa-and-appfolio-flags-operational-strain-and-tech-adoption-challenges",
    },
    {
      title: "AppFolio survey highlights shifts in property management employee productivity and satisfaction (Property Manager Hiring and Retention Report)",
      publisher: "AppFolio",
      year: 2023,
      url: "https://www.appfolio.com/newsroom/appfolio-survey-highlights-shifts-in-property-management-employee-productivity-and-satisfaction",
    },
    {
      title: "Occupational Outlook Handbook: Property, Real Estate, and Community Association Managers",
      publisher: "U.S. Bureau of Labor Statistics",
      year: 2025,
      url: "https://www.bls.gov/ooh/management/property-real-estate-and-community-association-managers.htm",
    },
    {
      title: "Apartment Turnover (member guidance quoting a Valet Living Quick Turns case study)",
      publisher: "National Apartment Association",
      year: 2025,
      url: "https://naahq.org/sites/default/files/2025-03/01a.%20Apartment%20Turnover%202025.pdf",
    },
  ],
};

const COST_OF_A_TURNOVER: BlogPost = {
  slug: "real-cost-of-a-turnover",
  title: "The real cost of a turnover",
  description:
    "A move-out costs more than the cleaning bill. What the National Apartment Association, Zego, Apartment List and the Census Bureau say about turns, empty days and vacancy.",
  date: "2026-10-13",
  readMinutes: 6,
  category: "Leasing",
  stats: [
    { value: "$1,800", label: "average cost of one move-out, NAA 2019 survey", sourceIndex: 0 },
    { value: "46.8%", label: "average apartment turnover rate in that survey", sourceIndex: 0 },
    { value: "$3,976", label: "all-in cost per resident, Zego's 2022 vendor survey", sourceIndex: 1 },
    { value: "34 days", label: "average listing-to-lease time, September 2026", sourceIndex: 2 },
    { value: "7.3%", label: "national rental vacancy rate, second quarter 2026", sourceIndex: 3 },
  ],
  sections: [
    {
      paragraphs: [
        "Most landlords can tell you what the painter charged. Fewer can tell you what a move-out cost in total, because the bill is spread across three places: the empty weeks, the repairs, and the hours spent finding the next resident. Public numbers exist, but they come from large apartment communities and from vendors, and they are older than you would like. Here is what they say, with each figure tied to who published it.",
      ],
    },
    {
      heading: "The trade association's number: $1,800 a move-out",
      paragraphs: [
        "The National Apartment Association's Apartment Turnover guidance, dated March 2025, cites the association's 2019 Survey of Operating Income & Expenses in Rental Housing Communities. It says “the turnover rate across apartment rentals averaged 46.8 percent last year. The average cost of a single move-out was conservatively calculated at $1,800. For a 200-unit community, that totals more than $168,000 in annual turnover expenses.”",
        "The multiplication holds: 200 units × 46.8% is 93.6 move-outs a year, and 93.6 × $1,800 is $168,480. Two caveats come with the number. The survey is from 2019, so costs have almost certainly moved since. And it describes apartment communities, not a landlord with a few houses, who also loses rent and pays to advertise; the guidance itself calls the figure “conservatively” calculated.",
        "The same guidance notes that “many companies in the industry use seven (7) working days as an average guideline to turn an apartment home,” with some expecting five or three.",
      ],
    },
    {
      heading: "A bigger number from a vendor: $3,976",
      paragraphs: [
        "Zego, a resident-experience software company, put the all-in cost higher. Its 2022 State of Resident Experience Management report, as reported by Multifamily Dive, found an average turnover cost of $3,976 per resident, up from $3,850 in 2021. The breakdown: lost rents $1,598, concessions $1,240, unit repairs $775, and marketing and advertising $364. Zego also reported: “It takes 17.6 months to recover the cost of losing a resident.”",
        "The four parts add to $3,977, a dollar over the headline; that is rounding in the source. This is a vendor survey, and the article does not state the sample size, so hold it more loosely than the federal figures below. Still, notice what the total is made of. Lost rent and concessions together are $2,838 (1,598 + 1,240), which is more than repairs and advertising combined at $1,139 (775 + 364). The painter is the smaller part of the bill.",
      ],
    },
    {
      heading: "How long a unit sits",
      paragraphs: [
        "Apartment List's National Rent Report, with September 2026 data, found that “units leased in September had been sitting on the market for an average of 34 days.” Median rent was $1,388. The report's vacancy index fell to 7 percent in September after peaking at 7.3% in February.",
        "That is a platform measure, listing to lease, for units advertised on Apartment List. It leaves out the days between a move-out and a listing going live. As an illustration only: $1,388 a month divided by 30 is $46.27 a day, and 34 days at that rate is about $1,573 of rent that did not arrive (46.27 × 34 = 1,573.18). That is in the neighborhood of Zego's $1,598 lost-rent figure, though the two come from different sources and measure different things.",
      ],
    },
    {
      heading: "The national vacancy rate",
      paragraphs: [
        "The U.S. Census Bureau's release for the second quarter of 2026 states: “National vacancy rates in the second quarter 2026 were 7.3 percent for rental housing and 1.2 percent for homeowner housing. The rental vacancy rate was not statistically different from the rate in the second quarter 2025 (7.0 percent).” The figure is not seasonally adjusted.",
        "It measures the share of units that are empty, not how many days a particular unit stays empty. That makes it the climate and not the forecast for your building.",
      ],
    },
    {
      heading: "Whether residents are about to leave",
      paragraphs: [
        "Moving intentions matter because every move starts a turn. Buildium's 2026 Renters Report, a vendor survey of 1,500 U.S. renters, found that 28% of renters plan to move between mid-2026 and mid-2027, up from 18% last year.",
        "On the other side, Greg Willett, chief economist at LeaseLock, wrote on July 30, 2026 that “56 percent of market rate apartment residents with leases expiring in the first half of 2026” signed renewals, citing RealPage's lease transaction database, with renewal rents up an average 3.5% so far in 2026. That covers market-rate apartments in RealPage's data, and there is no matching public figure for landlords with a handful of units. One source points at intent and the other at behavior, both come from vendors, and neither describes your building.",
      ],
    },
    {
      heading: "A ten-unit example, with the caveats attached",
      paragraphs: [
        "Take a landlord with ten units and the National Apartment Association's turnover rate of 46.8%. That is 10 × 0.468 = 4.68 move-outs a year. At the association's $1,800, the year costs 4.68 × 1,800 = $8,424. At Zego's $3,976, it costs 4.68 × 3,976 = $18,608, rounded.",
        "The range, roughly $8,400 to $18,600, is arithmetic on two averages from larger operators, not a measurement of any small portfolio. The two figures also count different things, so some of the spread is definitional. What to take from it is the order of magnitude. In units of Apartment List's $1,388 median rent, $1,800 is about 1.3 months of rent and $3,976 is about 2.9 months.",
      ],
    },
    {
      heading: "What to do about it",
      paragraphs: [
        "Count your own. For your last three move-outs, write down the days empty, the concessions, the repairs and what you spent on listing. Three of your own numbers beat any average in this post.",
        "Start the next turn the day notice arrives. Seven working days is a common guideline for turning a unit, according to the National Apartment Association's guidance, and every day you shave off is a day of rent: about $46 at the $1,388 median.",
        "Book the walk-through, the vendors and the listing photos before the move-out date, not after it. Waiting between steps is where the days go.",
        "Treat retention as the cheaper turn. If a resident asks to stay, a quick renewal costs a conversation, and the repair they have been waiting on is the first thing to fix. [PropLane](/) drafts resident reminders and follow-ups for a manager to approve, which keeps those conversations from slipping.",
      ],
    },
  ],
  sources: [
    {
      title: "Apartment Turnover (citing the 2019 Survey of Operating Income & Expenses in Rental Housing Communities)",
      publisher: "National Apartment Association",
      year: 2025,
      url: "https://naahq.org/sites/default/files/2025-03/01a.%20Apartment%20Turnover%202025.pdf",
    },
    {
      title: "State of Resident Experience Management report, as reported by Multifamily Dive: It costs nearly $4,000 to replace a resident when they leave",
      publisher: "Zego, via Multifamily Dive",
      year: 2022,
      url: "https://www.multifamilydive.com/news/it-costs-nearly-4000-to-replace-a-resident-when-they-leave",
    },
    {
      title: "National Rent Report (September 2026 data)",
      publisher: "Apartment List",
      year: 2026,
      url: "https://www.apartmentlist.com/research/national-rent-data",
    },
    {
      title: "Quarterly Residential Vacancies and Homeownership, Second Quarter 2026 (Release CB26-116)",
      publisher: "U.S. Census Bureau",
      year: 2026,
      url: "https://www.census.gov/housing/hvs/files/qtr226/Q226press.pdf",
    },
    {
      title: "2026 Renters Report",
      publisher: "Buildium",
      year: 2026,
      url: "https://www.buildium.com/resource/2026-renters-report/",
    },
    {
      title: "Greg Willett on multifamily resident retention and renewal pricing power (citing RealPage)",
      publisher: "LeaseLock",
      year: 2026,
      url: "https://leaselock.com/greg-willett-signposts-multifamily-resident-retention-renewal-pricing-power/",
    },
  ],
};

const WHAT_OWNERS_PAY: BlogPost = {
  slug: "what-owners-pay-a-property-manager",
  title: "What owners pay a property manager, and what they get",
  description:
    "Typical management fees from the best public dataset, how few small rentals use a manager at all, and what owners say they are buying.",
  date: "2026-10-14",
  readMinutes: 6,
  category: "Owners",
  stats: [
    { value: "8.49%", label: "average monthly management fee, advertised rates (2022)", sourceIndex: 0 },
    { value: "$101.04", label: "average flat fee per unit per month (2022)", sourceIndex: 0 },
    { value: "22%", label: "of 1-4 unit rental properties managed professionally (2021)", sourceIndex: 1 },
    { value: "45%", label: "of 5-49 unit properties managed entirely by the owner", sourceIndex: 2 },
  ],
  sections: [
    {
      paragraphs: [
        "Most owners of a few units are choosing between two unappealing options: do it yourself and give up evenings, or pay a percentage and wonder what it covers. The numbers below help with the second question. Know their limits first. The fee data is from 2022 and comes from a lead-generation publisher, and we found no independent, current survey of what small landlords actually pay managers.",
      ],
    },
    {
      heading: "The fee schedule, from advertised rates",
      paragraphs: [
        "iPropertyManagement.com, a publisher that connects owners with managers, analyzed 722 branches from 669 companies in 80 metro areas across 31 states, and last updated the study in September 2022. It found an average monthly management fee of 8.49% of collected rent, within an advertised range of 3.75% to 14.0%. Companies that charge a flat rate averaged $101.04 per unit per month, within a range of $49 to $250. The study says 8.49% “falls within the estimated nationwide average range of 6.00% to 10.0%.”",
        "The caveat that matters: these are advertised rates, not what owners actually paid, and the publisher earns its living from referrals. It is the best public dataset on the subject, and it is four years old.",
      ],
    },
    {
      heading: "The fees outside the monthly fee",
      paragraphs: [
        "The monthly line is only part of it. In the same study, leasing, meaning tenant placement, averaged 70.6% of rent when bought with management (range 6% to 125%) or a flat $555.53, and 81.8% of rent or $670.23 flat when bought alone. Among companies that charge for renewals, 83.4% use a flat fee, averaging $231.77 (range $32 to $1,000); percentage-based renewals averaged 30.33% of rent. Setup averaged $185.24 per contract, inspections averaged $106.72, and a maintenance reserve was typically $250 per unit.",
        "The labels are the study's. Read your own agreement the same way: what is monthly, what is charged per event, what is held in reserve. The same percentage can be cheap or expensive depending on how many of these other lines you also pay.",
      ],
    },
    {
      heading: "Percentage or flat: where the line falls",
      paragraphs: [
        "Using only the study's averages, the two pricing models cross where 8.49% of rent equals $101.04: 101.04 ÷ 0.0849 = $1,190.11 of monthly rent. Below that rent a percentage fee is cheaper; above it, the flat fee is.",
        "At Apartment List's median rent of $1,388 for September 2026, 8.49% is $117.84 a month, about $1,414 a year. At $101.04 flat, the year is 101.04 × 12 = $1,212.48. This is illustrative: the median rent is a different source's number for platform-listed units, and no real contract is only the monthly line. But it shows why a flat fee tends to suit higher rents and a percentage suits lower ones, and why comparing “8%” to “$100” by instinct goes wrong.",
      ],
    },
    {
      heading: "How many small rentals use a manager at all",
      paragraphs: [
        "HUD's November 2022 release on the 2021 Rental Housing Finance Survey, run with the Census Bureau, says “about 22 percent of small rental properties (1-4 units) are managed professionally,” against 84 percent of properties with 150 or more units. It also found that of the 49.5 million rental housing units in the U.S., “nearly 46 percent are located in rental properties of one-to-four units.”",
        "So for small rentals, paying a manager is the exception: 22% do, and by subtraction 78% do not. The survey is of 2021, and this post uses that edition only.",
      ],
    },
    {
      heading: "Where the owner is the manager",
      paragraphs: [
        "The Terner Center for Housing Innovation at UC Berkeley surveyed owners and managers of properties with 5 to 49 units from July to September 2022. It had 764 qualifying respondents, a response rate of about 2%, and weighted the results to the 2021 survey above. It found that “almost half of properties (45 percent) were managed entirely by the property owner. The remainder were managed either by a hired property management company or a directly employed agent.” About 10% of properties are held by owners who rely fully on rents for income, and another 44% by owners for whom rents are at least half of gross income.",
        "Terner discloses that the sample is small and California is over-represented. The second finding is the useful one here: 10% + 44% is 54% of properties held by owners who depend on rent for at least half of their income. For those owners the fee is a line in a budget they live on, which makes the contract worth reading closely.",
      ],
    },
    {
      heading: "What owners say they are buying",
      paragraphs: [
        "Buildium's 2026 State of the Property Management Industry Report, produced with Propertyware and NARPM, found that 56% of owners who use a manager do so for expert maintenance help. Buildium sells property management software, the full report is gated, and the public pages do not give the sample size, so treat the figure as a vendor survey's.",
        "Take it for what it says. The service owners report paying for is not rent collection or showings. It is someone who can deal with a repair. If a manager is slow on repairs, the fee is not buying the thing the owner came for.",
      ],
    },
    {
      heading: "What to do about it",
      paragraphs: [
        "Ask for every fee in writing, laid out as a table: monthly, leasing, renewal, setup, inspection, reserve, and what ending the contract costs. Compare each line with the averages above, remembering they are 2022 advertised rates.",
        "Ask how repairs are handled: who approves spending, up to what amount, how fast a resident gets an answer, and how you see the record. Maintenance is what owners say they are paying for, so test it before you sign.",
        "If you manage yourself, price the alternative. At the $1,388 median rent, 8.49% is $117.84 a month. Count the hours you spent last month on messages and repairs and decide whether the number is a bargain or a bad deal for you.",
        "If you keep managing yourself, [PropLane](/) has a free tier and drafts the routine messages for you to approve.",
      ],
    },
  ],
  sources: [
    {
      title: "Average Property Management Fees (research study, last updated September 7, 2022)",
      publisher: "iPropertyManagement.com",
      year: 2022,
      url: "https://ipropertymanagement.com/research/average-property-management-fees",
    },
    {
      title: "HUD Press Release No. 22-242: 2021 Rental Housing Finance Survey",
      publisher: "U.S. Department of Housing and Urban Development",
      year: 2022,
      url: "https://archives.hud.gov/news/2022/pr22-242.cfm",
    },
    {
      title: "The Ownership and Management of Small Multifamily Rental Properties",
      publisher: "Terner Center for Housing Innovation, UC Berkeley",
      year: 2024,
      url: "https://ternercenter.berkeley.edu/wp-content/uploads/2024/01/Ownership-and-Management-of-Small-Multifamily-Rental-Properties-January-2024-Final.pdf",
    },
    {
      title: "2026 State of the Property Management Industry Report",
      publisher: "Buildium, with Propertyware and NARPM",
      year: 2026,
      url: "https://www.buildium.com/resource/2026-property-management-industry-report/",
    },
    {
      title: "National Rent Report (September 2026 data)",
      publisher: "Apartment List",
      year: 2026,
      url: "https://www.apartmentlist.com/research/national-rent-data",
    },
  ],
};

const SLOW_REPAIRS: BlogPost = {
  slug: "slow-repairs-lose-residents",
  title: "Slow repairs lose residents",
  description:
    "What renters say they expect on repairs, how satisfaction with maintenance lines up with plans to renew, and how often small owners defer the work.",
  date: "2026-10-15",
  readMinutes: 6,
  category: "Maintenance",
  stats: [
    { value: "84%", label: "of renters expect a reply within 24 hours, Buildium survey", sourceIndex: 0 },
    { value: "61%", label: "expect a reply the same day or faster", sourceIndex: 0 },
    { value: "81%", label: "more likely to renew when satisfied with maintenance, AppFolio survey", sourceIndex: 1 },
    { value: "1 in 4", label: "small multifamily properties with postponed maintenance", sourceIndex: 2 },
  ],
  sections: [
    {
      paragraphs: [
        "Repairs are where the relationship between a landlord and a resident gets tested most often. Rent is due once a month and most months it simply arrives. A leaking tap, a dead outlet or a broken heater arrives at random, and the resident watches how long you take to answer. The public data on this is almost entirely from vendor surveys, so each figure below is named for who ran it and should be read as stated opinion, not observed behavior.",
      ],
    },
    {
      heading: "What renters expect: an answer within a day",
      paragraphs: [
        "Buildium's 2026 Renters Report, a vendor survey of 1,500 U.S. renters fielded in spring 2026, found that “84% of renters expect a response from their property manager within 24 hours” and “61% expect a response the same day or faster.” The breakdown: within one to two hours 17%, same day 44%, next business day 23%, two to three business days 11%, and four to five business days 5%.",
        "The pieces add up. 17% + 44% = 61% for same day or faster, and adding the 23% for next business day gives 84%. That leaves 16% (11% + 5%) who would wait two business days or more. Note that the question asks about a response, not a completed repair.",
      ],
    },
    {
      heading: "How maintenance feels from the other side",
      paragraphs: [
        "In the same Buildium survey, 24% of renters say maintenance is “the most stressful part of the resident experience,” and 25% report dissatisfaction with the completion of maintenance and repairs. Buildium also reports that 39% of renters say better maintenance follow-through is the leading factor, in its words.",
        "Owners feel it too. A Buildium blog post citing the company's 2026 State of the Property Management Industry Report says that “38% of rental owners say maintenance is their top source of stress, more than filling vacancies, managing residents, or collecting rent.” That figure appears in the blog post, not on the report's public preview, and Buildium does not give the sample size on either page.",
      ],
    },
    {
      heading: "Satisfaction and renewal",
      paragraphs: [
        "AppFolio's 2026 Renter Preferences Report is a vendor survey of 3,002 renters, fielded in early 2026 and syndicated by Stacker in September. It found that renters satisfied with maintenance are “81% more likely to renew and 36% less likely to move.” Among renters satisfied with maintenance, 79% said issues were resolved within a few days or less.",
        "Be careful with what that means. It links self-reported satisfaction to stated intent, not to renewals counted in a ledger. A satisfied renter is more likely to say they will stay; that is a weaker claim than the number being a measured retention gain.",
        "Buildium's 2026 Renters Report asks the question from the other direction. Among renters who are undecided about renewing, 37% say they would stay if their manager invested more in maintaining the property, and 35% say they would stay if their manager were more responsive. That is also stated intent, from a vendor survey, among a group that has not decided.",
      ],
    },
    {
      heading: "A view from a third vendor",
      paragraphs: [
        "Entrata's 2025 Resident Report, a vendor survey of more than 2,000 U.S. renters, found that 73% rated their property's maintenance process moderately-to-extremely effective. The other side of that figure is 27% (100 − 73) who did not rate it that way. Entrata sells property software too, so this is the third vendor in this post and each runs its own survey with its own wording. Their numbers should not be added together or averaged, and we have no breakdown for the residents of small landlords.",
        "If you want a rough sense of scale for a small building, Buildium's 25% dissatisfied with completion is 2.5 households out of ten (10 × 0.25). It is national survey data, so it is a prompt to ask your own residents, not a forecast.",
      ],
    },
    {
      heading: "What happens when repairs wait: the owner-side data",
      paragraphs: [
        "The Terner Center's study of small multifamily properties of 5 to 49 units, with 764 qualifying respondents from July to September 2022, found that “owners of one in four properties admitted to postponing maintenance of some kind. Minor maintenance issues were deferred in 21 percent of properties, and most maintenance work was postponed in another 4 percent.” The two shares do add up: 21% + 4% = 25%.",
        "It also reports that 28% of properties were in fair or poor condition, and that “owners of one in five properties reported that they did not conduct regular unit inspections.” The limits: the properties are larger than a typical small landlord's, the response rate was about 2%, and California is over-represented.",
        "What does deferred maintenance cost later? We looked for a solid figure for rental housing and did not find one. Multipliers circulate online, but we could not trace them to a primary source, so this post does not repeat them. What the data above can support is narrower: a quarter of small multifamily owners postpone work, and a fifth do not inspect.",
      ],
    },
    {
      heading: "What to do about it",
      paragraphs: [
        "Acknowledge every request the same day, even if the message only says you received it and when they will hear next. Buildium's survey says 61% of renters expect that speed.",
        "Give each request a status the resident can see: received, scheduled, done. A resident who can see where the repair stands has less reason to ask.",
        "Close the loop. When the repair is done, ask the resident to confirm it. Buildium found 25% of renters dissatisfied with completion, and the only way to find out whether yours are is to ask.",
        "Inspect on a schedule. Terner found that owners of one in five properties did not conduct regular unit inspections, and an inspection is where a small problem is found before it is a repair request.",
        "[PropLane](/) drafts the acknowledgement and the follow-up for a manager to approve.",
      ],
    },
  ],
  sources: [
    {
      title: "2026 Renters Report",
      publisher: "Buildium",
      year: 2026,
      url: "https://www.buildium.com/resource/2026-renters-report/",
    },
    {
      title: "What 3,002 renters say matters when free rent offers end (AppFolio 2026 Renter Preferences Report, syndicated by Stacker)",
      publisher: "AppFolio, via Stacker and KEYT",
      year: 2026,
      url: "https://keyt.com/stacker-real-estate/2026/09/12/what-3002-renters-say-matters-when-free-rent-offers-end/",
    },
    {
      title: "The Ownership and Management of Small Multifamily Rental Properties",
      publisher: "Terner Center for Housing Innovation, UC Berkeley",
      year: 2024,
      url: "https://ternercenter.berkeley.edu/wp-content/uploads/2024/01/Ownership-and-Management-of-Small-Multifamily-Rental-Properties-January-2024-Final.pdf",
    },
    {
      title: "2025 Resident Report",
      publisher: "Entrata",
      year: 2025,
      url: "https://go.entrata.com/rs/223-FOQ-437/images/Entrata-2025ResidentReport.pdf?version=0",
    },
    {
      title: "Maintenance as a competitive advantage (citing the 2026 State of the Property Management Industry Report)",
      publisher: "Buildium",
      year: 2026,
      url: "https://www.buildium.com/blog/maintenance-as-a-competitive-advantage/",
    },
  ],
};

const WHO_OWNS_RENTALS: BlogPost = {
  slug: "who-owns-americas-rentals",
  title: "Who owns America's rentals? Mostly small landlords",
  description:
    "Federal survey data on who owns rental housing, how few small properties use a professional manager, and what residents falling behind on rent looks like nationally.",
  date: "2026-10-16",
  readMinutes: 6,
  category: "Industry",
  stats: [
    { value: "46%", label: "of rental units are in 1-4 unit properties (2021)", sourceIndex: 0 },
    { value: "70%", label: "of rental properties are owned by individual investors (2021)", sourceIndex: 0 },
    { value: "22%", label: "of 1-4 unit rental properties are managed professionally (2021)", sourceIndex: 0 },
    { value: "23%", label: "of renters were behind on rent at some point in 2025, Federal Reserve survey", sourceIndex: 1 },
  ],
  sections: [
    {
      paragraphs: [
        "The picture of a landlord as a large company is common in headlines and less common in the data. Federal surveys describe a rental market in which much of the stock sits in small buildings owned by individuals, most of them managing without a firm. This post lays out those numbers, then the rent-collection data those owners work against. Every ownership figure is from the 2021 Rental Housing Finance Survey; none is mixed with figures from another year.",
      ],
    },
    {
      heading: "Small buildings hold a large share of the stock",
      paragraphs: [
        "HUD's November 2022 release on the 2021 Rental Housing Finance Survey, run with the Census Bureau, says: “Of the 49.5 million rental housing units in the U.S., nearly 46 percent are located in rental properties of one-to-four units.” By simple multiplication, 49.5 million × 0.46 is about 22.8 million units.",
        "The Terner Center for Housing Innovation looks at the next size up. It defines small multifamily as five to 49 units and says these properties make up “about 17 percent of the nation's rental housing, totaling about 8.2 million units across nearly 500,000 properties.” These are two studies with two size bands and two sets of definitions, so do not add the shares together.",
      ],
    },
    {
      heading: "Who owns them: individuals",
      paragraphs: [
        "HUD's release says: “For these small rental properties, 70 percent (15.9 million) are owned by individual investors and more than one-third (8.1 million) have a mortgage or similar debt.” Across all sizes: “About 70 percent of rental properties, representing 38 percent of all rental units, are owned by individual investors.”",
        "Read the second sentence slowly. Individual investors own about 70% of rental properties but 38% of rental units, because their buildings are small. Whether landlords are mostly small depends on whether you count buildings or apartments. By buildings, individuals dominate. By apartments, 62% of units (100 − 38) belong to owners other than individual investors.",
      ],
    },
    {
      heading: "Most of them manage without a firm",
      paragraphs: [
        "HUD's release also says: “About 22 percent of small rental properties (1-4 units) are managed professionally.” The comparison at the other end is 84 percent of properties with 150 or more units. By subtraction, 78% of small rental properties are not managed professionally.",
        "The Terner Center found a similar pattern one size up, in a survey of 5 to 49 unit properties from July to September 2022 with 764 qualifying respondents: “almost half of properties (45 percent) were managed entirely by the property owner.” These are different surveys of different size bands, so do not read them as one trend. Together they say that owners running their own buildings are not an exception.",
      ],
    },
    {
      heading: "What those owners are up against: late rent",
      paragraphs: [
        "The Federal Reserve Board's Economic Well-Being of U.S. Households in 2025, released in May 2026 from a survey of nearly 13,000 adults, reports: “Twenty-three percent of renters reported that they had been behind on their rent at some point in the past year, up 2 percentage points from 2024 and 6 percentage points since 2021.” By subtraction, that was 21% in 2024 and 17% in 2021.",
        "The limits matter. This is renters' own report over a year, nationwide. It is not a landlord's monthly late rate, and it does not say how many days late. If your residents matched the national sample, which is a big if, 23% of ten households is between two and three households behind at some point in a year (10 × 0.23 = 2.3).",
        "The Consumer Financial Protection Bureau's January 2025 report on rental delinquencies used purchased rental payment data from September 2021 through November 2024. It looked at late fees: the share of renters paying one in the past 12 months rose from 15.4% at the end of 2021 to 23% at the start of 2023, then “declined to 14 percent by November 2024.” It put the average late fee at “around $85.” The 23% there is a different measure from the Federal Reserve's 23%, and the match is a coincidence. The CFPB data also ends before 2025.",
      ],
    },
    {
      heading: "Who falls behind",
      paragraphs: [
        "The same Federal Reserve report finds that the burden is uneven: nearly one-third of renters with income under $50,000 were behind on rent. That is a national pattern across income groups and says nothing about whether any one landlord's residents are in that group.",
      ],
    },
    {
      heading: "What the numbers leave out",
      paragraphs: [
        "We found no public survey that measures how much of a small landlord's rent arrives late, or what it costs them to chase it. The Federal Reserve and the CFPB see it from the renter's side. HUD and the Terner Center tell us who owns the buildings. The gap between those two sets of data is where a small landlord's own records sit.",
      ],
    },
    {
      heading: "What to do about it",
      paragraphs: [
        "Keep your own late-rent record: how many residents were late each month, by how many days, and what you charged. There is no benchmark for small portfolios, so your record is the benchmark.",
        "Write down your late-rent routine once: when the reminder goes out, what the first message says, and what happens at day five. Notices about late rent and deposits are regulated and vary by state, so have those reviewed locally rather than copied from a template.",
        "Decide your late-fee policy before you need it. The CFPB's average of around $85 is an average from payment data, not a standard or a legal limit, and what you may charge depends on your lease and your state.",
        "If you manage yourself, as most owners of small buildings do, choose one place where all resident messages live, so a late-rent conversation is not split between your texts and your email.",
        "[PropLane](/) sends rent reminders on a schedule you set and drafts replies for you to approve.",
      ],
    },
  ],
  sources: [
    {
      title: "HUD Press Release No. 22-242: 2021 Rental Housing Finance Survey",
      publisher: "U.S. Department of Housing and Urban Development",
      year: 2022,
      url: "https://archives.hud.gov/news/2022/pr22-242.cfm",
    },
    {
      title: "Economic Well-Being of U.S. Households in 2025",
      publisher: "Board of Governors of the Federal Reserve System",
      year: 2026,
      url: "https://www.federalreserve.gov/publications/files/2025-report-economic-well-being-us-households-202605.pdf",
    },
    {
      title: "Behind on rent: examining rental housing delinquencies in new payment data",
      publisher: "Consumer Financial Protection Bureau",
      year: 2025,
      url: "https://www.consumerfinance.gov/data-research/research-reports/behind-on-rent-examining-rental-housing-delinquencies-in-new-payment-data/",
    },
    {
      title: "The Ownership and Management of Small Multifamily Rental Properties",
      publisher: "Terner Center for Housing Innovation, UC Berkeley",
      year: 2024,
      url: "https://ternercenter.berkeley.edu/wp-content/uploads/2024/01/Ownership-and-Management-of-Small-Multifamily-Rental-Properties-January-2024-Final.pdf",
    },
  ],
};

/** All posts, newest first. */
export const BLOG_POSTS: readonly BlogPost[] = [
  WHO_OWNS_RENTALS,
  SLOW_REPAIRS,
  WHAT_OWNERS_PAY,
  COST_OF_A_TURNOVER,
  WEEK_OF_A_MANAGER,
];

export function getBlogPost(slug: string): BlogPost | undefined {
  return BLOG_POSTS.find((p) => p.slug === slug);
}

/** `2026-10-12` rendered as "October 12, 2026", independent of the viewer's time zone. */
export function formatBlogDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** Words in the body (headings and paragraphs), with inline-link markup reduced to its label. */
export function blogWordCount(post: BlogPost): number {
  const text = post.sections
    .flatMap((s) => [s.heading ?? "", ...s.paragraphs])
    .join(" ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  return text.split(/\s+/).filter(Boolean).length;
}
