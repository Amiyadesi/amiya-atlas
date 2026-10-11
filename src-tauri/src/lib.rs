mod ai;
#[cfg(feature = "desktop")]
mod bridge;
mod capture;
mod crypto;
#[cfg(feature = "desktop")]
mod desktop;
mod domain;
#[cfg(feature = "desktop")]
mod quick_capture;
mod store;
mod vault;
mod voice;
#[cfg(feature = "desktop")]
pub use desktop::run;
#[cfg(test)]
mod capture_change_tests;
#[cfg(test)]
mod vault_tests;
