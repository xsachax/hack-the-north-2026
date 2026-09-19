"use client";

/* eslint-disable @next/next/no-html-link-for-pages, @next/next/no-location-assign-relative-destination -- Full document navigation reloads validated tab-local state without router prefetch. */

import { useState, useSyncExternalStore } from "react";
import {
  addProject, BOARD_STORAGE_KEY, projectCategories, projectSchema, readBoardState, type BoardState,
} from "@/lib/project-board";
import "./board.css";
import { DemoPreference } from "@/components/demo-preference";

const subscribe = () => () => {};

export function ProjectBoard({ route }: { route: string }) {
  const ready = useSyncExternalStore(subscribe, () => true, () => false);
  return <main className="project-board">
    <header><a href="/project-board">Paperplane project board</a><p>Synthetic projects for browser testing. Nothing leaves this tab.</p></header>
    <nav aria-label="Project board"><a href="/project-board/new">New project</a><a href="/project-board/projects">All projects</a></nav>
    {ready ? <BoardContent route={route} /> : <p role="status">Opening the project board...</p>}
    <DemoPreference />
  </main>;
}

function BoardContent({ route }: { route: string }) {
  const [initial] = useState(() => {
    try { return { state: readBoardState(sessionStorage.getItem(BOARD_STORAGE_KEY)), error: "" }; }
    catch { return { state: null, error: "Project board storage could not be read. Reset this tab or enable browser storage." }; }
  });
  const [state, setState] = useState<BoardState | null>(initial.state);
  const [error, setError] = useState(initial.error);

  function save(next: BoardState): boolean {
    try {
      const encoded = JSON.stringify(next);
      const validated = readBoardState(encoded);
      sessionStorage.setItem(BOARD_STORAGE_KEY, encoded);
      setState(validated);
      setError("");
      return true;
    } catch {
      setError("Project board could not be saved. Enable browser storage before continuing.");
      return false;
    }
  }

  return <>
    {error && <p role="alert">{error}</p>}
    {!state ? <button onClick={() => save({ version: 1, projects: [] })}>Reset this tab</button> : <>
      {route === "" && <section>
        <h1>A small home for your next idea.</h1>
        <p>Create a named project and choose Research, Design, or Engineering. Find it in All projects.</p>
        <a href="/project-board/new">Create your first project</a>
      </section>}
      {route === "new" && <section>
        <h1>Create a project</h1>
        <form onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const parsed = projectSchema.safeParse({ name: form.get("name"), category: form.get("category") });
          if (!parsed.success) { setError("Enter a project name (1–60 characters) and choose a category."); return; }
          let next: BoardState;
          try { next = addProject(state, parsed.data); }
          catch (error) { setError(error instanceof Error ? error.message : "Project could not be created."); return; }
          if (save(next)) window.location.assign("/project-board/projects");
        }}>
          <label>Project name<input name="name" type="text" maxLength={60} required autoComplete="off" /></label>
          <div><label htmlFor="project-category">Category</label><select id="project-category" name="category" defaultValue="Research">
            {projectCategories.map((category) => <option key={category}>{category}</option>)}
          </select></div>
          <button type="submit">Create project</button>
        </form>
      </section>}
      {route === "projects" && <section>
        <h1>Your projects</h1>
        {state.projects.length === 0 ? <p>No projects yet. Start with New project.</p> : <ul aria-label="Projects">
          {state.projects.map((project) => <li key={project.name}><h2>{project.name}</h2><p>Category: {project.category}</p></li>)}
        </ul>}
        <p>{state.projects.length} of 12 synthetic projects in this tab.</p>
        <button onClick={() => save({ version: 1, projects: [] })}>Reset this tab</button>
      </section>}
    </>}
  </>;
}
