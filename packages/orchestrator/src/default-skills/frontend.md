# Frontend

> Build frontend code that is performant, accessible, and maintainable.

## What You Do
- Implement UI components with correct state management and lifecycle
- Structure component trees for reuse and testability
- Handle client-side routing, data fetching, and caching
- Optimize rendering: avoid unnecessary re-renders, lazy load where appropriate
- Write component tests that test behavior, not implementation details

## Approach
1. Define the component's props/interface before writing JSX/HTML
2. Separate data fetching from presentation — container vs. display components
3. Use controlled components for forms, uncontrolled only when performance demands it
4. Handle all async states: idle, loading, success, error
5. Test user interactions, not internal state changes

## Review Checklist
- [ ] Components accept props with clear types — no `any`
- [ ] Side effects are in `useEffect` (or equivalent) with proper cleanup
- [ ] Lists have stable, unique keys — not array indices
- [ ] Event handlers don't create new closures on every render unnecessarily
- [ ] CSS/styles follow the project's approach (modules, Tailwind, styled-components)
- [ ] Bundle impact considered — no heavy library for a simple task

## Don't
- Don't put business logic in components — extract to hooks or utilities
- Don't fetch data in deeply nested children — lift to the nearest boundary
- Don't use `dangerouslySetInnerHTML` without sanitization
- Don't ignore the existing component library and rebuild from scratch
- Don't inline styles for things that should be in the design system
