# Claudegram Development Guidelines

## Website Maintenance

When making changes to the codebase, keep `docs/index.html` updated:

### New Features
When adding a new feature, add a feature card to the features section:
```html
<div class="feature-card">
  <div class="feature-icon">[emoji]</div>
  <h3>Feature Name</h3>
  <p>Brief description of what the feature does.</p>
</div>
```

### New Commands
When adding a new bot command, add it to the commands section:
```html
<div class="command-row">
  <code class="command-code">/command &lt;args&gt;</code>
  <span class="command-desc">Description of what the command does</span>
</div>
```

### New Contributors
When a new contributor makes significant contributions, add them to the contributors section:
```html
<a href="https://github.com/username" class="contributor-card" target="_blank">
  <img src="https://github.com/username.png" alt="username" class="contributor-avatar">
  <span class="contributor-name">Display Name</span>
  <span class="contributor-role">Contributor</span>
</a>
```

## Code Style

- TypeScript for all source files
- Functional patterns preferred
- Use existing utilities from `src/utils/` (download, sanitize, file-type)
- Validate external input (URLs, file content) using existing helpers

## Security Checklist

Before committing changes that handle external input:
- [ ] URL protocol validation using `isValidProtocol()` from `src/utils/download.ts`
- [ ] Path sanitization using `sanitizePath()` from `src/utils/sanitize.ts`
- [ ] Error sanitization using `sanitizeError()` before logging
- [ ] File content validation using `isValidImageFile()` for images
- [ ] No tokens or secrets in process arguments (use stdin for curl)
