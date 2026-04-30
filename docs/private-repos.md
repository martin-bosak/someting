# Private Repository Deploys

Each site can have its own deploy credentials configured in the admin UI:

```text
Site card -> Deploy Auth
```

Credentials are stored under the site folder on the host:

```text
/srv/hosting/sites/<slug>/deploy.env
/srv/hosting/sites/<slug>/deploy_key
```

They are not stored in Git and are not rendered back into the admin UI after saving.

## HTTPS Token

Use this for GitHub HTTPS repository URLs such as:

```text
https://github.com/owner/private-repo.git
```

For GitHub fine-grained tokens, the username can usually be:

```text
x-access-token
```

The token needs read access to the repository contents.

## SSH Deploy Key

Use this for SSH repository URLs such as:

```text
git@github.com:owner/private-repo.git
```

Paste the private key in the admin form and add the corresponding public key as a deploy key in GitHub.

## Clearing Credentials

Use `Clear credentials` when:

- the repo becomes public,
- a token/key is rotated,
- the site is deployed by upload instead of Git.
