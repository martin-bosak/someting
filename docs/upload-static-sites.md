# Upload Static Sites

Use this flow for a folder that contains plain files such as:

```text
index.html
styles.css
images/
```

No Git repository is required.

## Upload From Windows

```powershell
.\deploy\upload-static-site.ps1 -Slug my-page -Path C:\path\to\site -Name "My Page"
```

Or with the CMD wrapper:

```bat
deploy\upload-static-site.cmd -Slug my-page -Path C:\path\to\site -Name "My Page"
```

The command:

- archives the local folder,
- copies it to the VPS over SSH,
- extracts it as a new release under `/srv/hosting/sites/<slug>/releases`,
- starts or rebuilds the `site-<slug>` container,
- registers the site in the management database as runtime `html`.

## Route A Domain

After upload, add a domain in the web admin or MCP, then run `Apply route`.

The uploaded site source is recorded as:

```text
upload://my-page
```

## Redeploy

Run the same upload command again. Each upload creates a new release and keeps the latest five releases.
