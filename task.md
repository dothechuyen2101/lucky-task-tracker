# Task: Task review workflow and proof of completion

## Background

Right now, when someone finishes a task, the person who assigned it only gets a Discord message saying "task done" and has no way to verify the work was actually done.

## Requirements

1. **Tasks do not finish automatically.** When the assignee reports a task as done, it moves to a pending-review state.
2. **The reviewer is the task creator.** The bot sends the pending task to the creator on Discord, with a link that opens that task directly in the tool.
3. **Four review options in the tool:**

   | Option | Meaning | Score |
   |---|---|---|
   | Approve, on time | Completed by the deadline | Counts toward the 5-task streak for +0.5 |
   | Approve, late | Completed after the deadline | -1 |
   | Disapprove | The assignee failed to do it | -1 |
   | Extend deadline | Deadline extended, task continues | No penalty |

4. **After Disapprove, the creator picks one of two outcomes:**
   - **Close:** the task moves to a failed state and ends.
   - **Reopen:** the task goes back to in progress so the assignee can keep working, and the creator sets a new deadline.
5. **Proof is mandatory.** When reporting a task as done, the assignee must submit proof: an image, link, file, or text are all accepted.
6. **Proof is submitted via chat.** The assignee sends the proof in Discord and tags the bot, and the bot attaches it to a task in this order:
   - If the message is a reply to the original task message, attach it to that task.
   - If it is not a reply and the sender has only one open task, attach it to that task automatically.
   - If the sender has several open tasks, the bot shows a list to choose from.
7. **Filtering and sorting the task list.**
   - Add a **Priority** field to each task (High, Medium, Low), since the tool does not have one yet. The creator sets it when creating the task and can change it later.
   - **Sort** by priority or by time (deadline, date created), ascending or descending.
   - **Filter** by priority and by deadline date range.
   - Applies to all existing tabs: All, Assigned to me, I asked for, To review, Done & dismissed.

## Acceptance criteria

- No task moves to Completed until the creator approves it.
- A task cannot be reported as done without proof attached.
- The Discord message to the creator links to the correct task, and the proof is viewable inside that task.
- Scores update according to the table above as soon as the creator makes a choice.
- After an extension, the task returns to in progress with the new deadline and no points are deducted.
- Clicking Disapprove requires choosing Close or Reopen before confirming, and the -1 is applied immediately in both cases.
- A reopened task keeps its earlier proof and review history.
- Filters and sorting can be combined with each other and with the search box.
- The chosen filter and sort persist when switching tabs or reloading the page.
- Existing tasks without a priority default to Medium.
