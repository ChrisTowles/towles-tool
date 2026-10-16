//! Output data types for the Claude Sessions aggregates.
//!

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolData {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBar {
    pub project: String,
    pub total_tokens: i64,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelBar {
    pub model: String,
    pub total_tokens: i64,
    pub cost_usd: f64,
}

/// One day of the stacked bar chart: per-project token totals.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BarChartDay {
    pub date: String,
    pub projects: Vec<ProjectBar>,
    pub cost_usd: f64,
}
