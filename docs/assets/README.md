# Public Assets

`readme-cover.webp` is the project-specific editorial artwork used in the repository README.
It must remain a 1600x900 WebP at no more than 500 KiB, with no source PNG or JPEG sibling.

`npm run verify:presentation` checks the README placement, copy, alt text, exact case-sensitive path,
binary signature, dimensions, size, and public-safe location. The private canonical checkout also
checks internal generation provenance; public checkouts require only the README and published asset.
