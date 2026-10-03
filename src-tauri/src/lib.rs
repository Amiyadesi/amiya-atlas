mod ai;
#[cfg(feature = "desktop")]
mod bridge;
mod capture;
mod crypto;
#[cfg(feature = "desktop")]
mod desktop;
mod domain;
mod store;
mod vault;
mod voice;
#[cfg(feature = "desktop")]
mod quick_capture;
#[cfg(feature = "desktop")]
pub use desktop::run;
#[cfg(test)]
mod vault_tests;
