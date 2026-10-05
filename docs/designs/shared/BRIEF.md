# Design brief: AW Appointment Matching, results workspace

## Subject
Dennison & Associates (D&A) runs the AW appointment show: a hospitality and association-events trade show.
Buyers are association meeting planners (e.g. "CA Medical Association - Senior Director, Meetings & Conferences").
Suppliers are hotels, resorts, convention bureaus ("hotel" type, 47) and business vendors ("business" type, 9: event tech, HR, staffing).
In one afternoon there are 9 ten-minute appointment slots (3:10 PM to 4:48 PM). Each supplier sits at a numbered desk and gets exactly 9 buyers. Each buyer gets 7 to 9 suppliers.
A matching engine pairs them from mutual rankings. D&A staff (2 to 4 people, non-technical, Excel-literate) review the result, fix weak spots by hand, lock it, export it, and email everyone their schedule.

Audience for this screen: D&A admin staff on a laptop, sometimes a tablet on the show floor.
Primary job: "Is this schedule good, where are the problems, and who is meeting whom when?"

The client hated the 2025 version: a purple/blue gradient header, identical rounded white cards, generic tabs. Do not use purple/blue gradients. Do not produce the generic SaaS card kit.

## Data
Load with `<script src="../shared/aw-data.js"></script>` which sets `window.AW_DATA`:
```
{
  event: { name, client, date, manualChanges: 12,
           settings: { supplierTarget: 9, buyerMin: 7, buyerMax: 9, buyerIdeal: 8, mutualTopN: 10, hotelRankCutoff: 27 } },
  slots: [{ n: 1, start: "3:10 PM", end: "3:20 PM" }, ... 9 items],
  suppliers: [{ name, type: "business" | "hotel", desk: 1..56 }],      // 56
  buyers: [{ name, organization, title }],                            // 65, name = "Org - Title"
  appointments: [{ slot, supplier, buyer, type, desk, buyerRank, supplierRank }]  // 504
}
```
- buyerRank = how the buyer ranked that supplier (1 is best). null = buyer left it blank.
- supplierRank = how the supplier ranked that buyer. null = blank.
- "Mutual top-10" = both ranks present and both <= 10. 126 of 504.
- Buyer counts: one buyer has 5, two have 6, thirteen have 7, forty-five have 8, four have 9. Suppliers: all 56 at exactly 9.
- Compute every number from the data. Never hardcode stats. Do NOT edit aw-data.js.

## Required features (parity across all designs)
1. Event header: event name, status (e.g. "Draft, not locked"), and the admin actions as buttons: Run matching, Edit schedule, Lock schedule, Export. Buttons can be non-functional, but a click should at least show a toast or open the relevant panel.
2. Three ways to look at the schedule: by time slot, by buyer, by supplier. Plus a quality / alerts view. You choose the navigation pattern, it does not have to be tabs.
3. Search that works in every view (buyer name, organization, supplier name).
4. "Open slot" filter: show only buyers or suppliers who are free in slot N. Buyers below target have open slots; that is how staff find room to fix them.
5. Every appointment shows: supplier, buyer, slot time, desk, buyer rank and supplier rank (blank shown as a dash), mutual top-10 visibly distinguished, business vs hotel visibly distinguished.
6. Count health: buyers below 7 or above 9 flagged; suppliers not at 9 flagged.
7. Quality view: total appointments, suppliers at 9 (x/56), buyers at 7 to 9 (x/65), buyer distribution, mutual top-10 count and %, one-side top-10, neither top-10, blank rankings, list of buyers below and above target, "12 manual changes applied".
8. Clicking an appointment, buyer or supplier opens a detail panel (side sheet or equivalent) with that person's full 9-slot schedule, OPEN slots shown explicitly.
9. Responsive down to a 390px phone. Visible keyboard focus. Respect prefers-reduced-motion.

## Implementation constraints
- One file: `designs/<NN-slug>/index.html`. No build step. Must work served over http from the `designs/` folder.
- Tailwind v4 browser build: `<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>` with a `<style type="text/tailwindcss">` block.
- The real app will be React + shadcn/ui (Radix base). So the mockup must be buildable from shadcn primitives:
  - Define the theme the shadcn way: CSS variables `--background --foreground --card --card-foreground --popover --primary --primary-foreground --secondary --muted --muted-foreground --accent --destructive --border --input --ring --radius --chart-1..5`, plus any custom semantic tokens you need (e.g. `--mutual`, `--business`, `--hotel`, `--warning`), mapped in `@theme inline`. OKLCH preferred. Use semantic utilities (bg-primary, text-muted-foreground), not raw palette colors, in markup.
  - Compose from things shadcn has: Button, Badge, Tabs, Card, Table, Input, InputGroup, ToggleGroup, Select, Command (cmd-K), Sheet, Dialog, Tooltip, HoverCard, Popover, Sidebar, Separator, ScrollArea, Progress, Chart (Recharts), Alert, Empty, Skeleton, sonner toast, Resizable, Accordion, Kbd. Mimic their markup/behaviour in vanilla HTML/JS. Visual personality comes from tokens, type, layout and density, not from inventing new primitives.
  - Add `data-slot="<shadcn component name>"` on the elements that map to a shadcn component, so the mapping is legible.
- Vanilla JS only (no React CDN). Render from AW_DATA. Keep it tidy: one render function per view.
- Google Fonts allowed. Lucide icons allowed via `https://unpkg.com/lucide@latest` if needed.
- At the very top of the file, an HTML comment containing: design name, concept in two sentences, palette (named hex/oklch), type, layout, and the list of shadcn components used.

## Quality bar
Follow the frontend-design skill (at ~/.claude/skills/frontend-design/SKILL.md): plan tokens first, check the plan against the generic defaults list, then build. Spend boldness in one place. Real content only, written in plain sentence-case English. No lorem ipsum.
