---
name: trip-planning
description: Use when the user wants a trip or weekend planned. Covers how to gather preferences and lay out an itinerary.
---

# Planning a trip

1. Make a todo list with `todo_write` so the user can follow along.
2. Ask the essentials in one `ask_user` call: dates, budget, pace (relaxed or packed).
3. Check the weather for the destination.
4. Hand destination research to the `researcher` subagent.
5. Find flights (load the bookings tools with `search_tools`). Don't book without the user's go-ahead.
6. Finish with a day-by-day plan: morning, afternoon, evening, one line each.

See `checklist.md` for the packing list to append at the end.
