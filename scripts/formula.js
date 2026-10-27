const RELEASES = 'https://github.com/fatlard1993/ender-launcher/releases/download';

/** The binaries Homebrew installs, by the system and chip blocks its formula keeps them in. */
const PLATFORMS = {
	on_macos: { on_arm: 'darwin-arm64', on_intel: 'darwin-x64' },
	on_linux: { on_arm: 'linux-arm64', on_intel: 'linux-x64' },
};

/** Each binary's sha256, by its name, from a sha256sum listing. */
export const sumsOf = listing =>
	new Map(
		listing
			.split('\n')
			.map(line => line.trim().split(/\s+/))
			.filter(([sum, name]) => sum && name)
			.map(([sum, name]) => [name.replace(/^\*/, ''), sum]),
	);

/** The Homebrew formula for a release: each platform's binary, checked by its sha256, installed as ender. */
export const formula = (version, sums) => {
	const binary = target => {
		const sum = sums.get(`ender-${target}`);

		if (!sum) throw new Error(`No sha256 for ender-${target}`);

		return `      url "${RELEASES}/v${version}/ender-${target}"\n      sha256 "${sum}"`;
	};
	const blocks = Object.entries(PLATFORMS).map(
		([system, chips]) =>
			`  ${system} do\n${Object.entries(chips)
				.map(([chip, target]) => `    ${chip} do\n${binary(target)}\n    end`)
				.join('\n')}\n  end`,
	);

	return `class Ender < Formula
  desc "Minecraft instances, mods and servers from the command line"
  homepage "https://github.com/fatlard1993/ender-launcher"
  version "${version}"
  license "MIT"

${blocks.join('\n\n')}

  def install
    bin.install Dir["ender-*"].first => "ender"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/ender --version")
  end
end
`;
};

if (import.meta.main) {
	const [version, listing] = process.argv.slice(2);

	process.stdout.write(formula(version, sumsOf(await Bun.file(listing).text())));
}
