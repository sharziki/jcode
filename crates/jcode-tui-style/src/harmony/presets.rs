//! Named palette starting points for one-command theme switching.

use super::generate_from_seed;
use crate::palette::Palette;

/// A built-in palette preset.
///
/// Presets store only their identity color. The existing generator expands it
/// into all semantic roles for the active terminal background, keeping every
/// preset readable in both dark and light mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ColorPreset {
    pub name: &'static str,
    pub description: &'static str,
    pub seed: (u8, u8, u8),
}

impl ColorPreset {
    pub fn palette(self, background: (u8, u8, u8)) -> Palette {
        generate_from_seed(self.seed, background)
    }
}

pub const COLOR_PRESETS: &[ColorPreset] = &[
    ColorPreset {
        name: "sonic",
        description: "cobalt blue, cyan highlights, and ring-gold warnings",
        seed: (0x16, 0x77, 0xff),
    },
    ColorPreset {
        name: "matrix",
        description: "phosphor green on dark terminals",
        seed: (0x39, 0xff, 0x14),
    },
    ColorPreset {
        name: "ocean",
        description: "deep blue and cool teal",
        seed: (0x00, 0xa8, 0xcc),
    },
    ColorPreset {
        name: "violet",
        description: "soft purple with split-complementary status colors",
        seed: (0x9b, 0x5d, 0xe5),
    },
    ColorPreset {
        name: "sunset",
        description: "warm coral and dusk-blue contrast",
        seed: (0xff, 0x7a, 0x59),
    },
    ColorPreset {
        name: "amber",
        description: "warm terminal gold with cool information colors",
        seed: (0xd9, 0x9a, 0x00),
    },
    ColorPreset {
        name: "rose",
        description: "muted pink with crisp semantic states",
        seed: (0xe8, 0x5d, 0x8e),
    },
    ColorPreset {
        name: "frost",
        description: "quiet arctic blue with restrained saturation",
        seed: (0x88, 0xc0, 0xd0),
    },
];

pub fn find_color_preset(name: &str) -> Option<ColorPreset> {
    let normalized = name.trim().to_ascii_lowercase().replace(['_', ' '], "-");
    COLOR_PRESETS
        .iter()
        .copied()
        .find(|preset| preset.name == normalized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::palette::ALL_ROLES;

    #[test]
    fn preset_names_are_unique_and_lookup_is_forgiving() {
        let mut names = COLOR_PRESETS
            .iter()
            .map(|preset| preset.name)
            .collect::<Vec<_>>();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), COLOR_PRESETS.len());
        assert_eq!(
            find_color_preset("SONIC").map(|preset| preset.name),
            Some("sonic")
        );
    }

    #[test]
    fn every_preset_populates_every_role_on_light_and_dark_backgrounds() {
        for background in [(18, 18, 18), (255, 255, 255)] {
            for preset in COLOR_PRESETS {
                let palette = preset.palette(background);
                for role in ALL_ROLES.iter().copied() {
                    assert!(
                        palette.is_overridden(role),
                        "{} did not populate {}",
                        preset.name,
                        role.key()
                    );
                }
            }
        }
    }
}
