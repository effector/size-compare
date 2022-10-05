# size-compare

```yaml
      - name: 🚛 Size compare
        uses: effector/size-compare@main
        with:
          token: ${{ secrets.SIZE_COMPARE_TOKEN }}
          gist-id: cc36a9a386a87c423a0f2ea9a663f11b
          bundle-directory: ./dist
          include: '**/*.js'
          exclude: '**/*.map'
```

- Check size on `main` / `master` on each commit
- Save size on "main" branch into history into the gist (with the commit hash and date)
- On PR's send size comparison with the target branch (must be "main")
- Do not check drafts (by option)

Reference: https://github.com/facebook/react/pull/25387#issuecomment-1265581757
