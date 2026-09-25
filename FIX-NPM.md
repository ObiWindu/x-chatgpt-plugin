# Fix for `npm install` ENOENT

The GitHub runner error:

```text
ENOENT: no such file or directory, open '.../x-chatgpt-plugin/x-chatgpt-plugin/package.json'
```

means `package.json` is missing from the directory where the workflow runs.

This corrected project places `package.json` at repository root.

The expected Git repository layout is:

```text
x-chatgpt-plugin/
├── package.json
├── tsconfig.json
├── Dockerfile
├── src/
│   └── server.ts
└── .github/
    └── workflows/
        └── node.yml
```

## Fix

Copy the files from this project into your GitHub repository, then commit:

```bash
git add package.json tsconfig.json Dockerfile .dockerignore src .github
git commit -m "Fix project structure for npm install"
git push
```

Then the existing workflow can simply run:

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with:
    node-version: 22
    cache: npm
- run: npm install
- run: npm run typecheck
```

Do **not** add:

```yaml
working-directory: x-chatgpt-plugin
```

unless `package.json` is actually inside that subdirectory.

If your repository really has this structure:

```text
repo/
└── x-chatgpt-plugin/
    ├── package.json
    └── src/
```

then use:

```yaml
- name: Install dependencies
  working-directory: x-chatgpt-plugin
  run: npm install
```

The path in your error strongly indicates that your workflow expects a project directory named `x-chatgpt-plugin`; first verify where `package.json` is committed.
