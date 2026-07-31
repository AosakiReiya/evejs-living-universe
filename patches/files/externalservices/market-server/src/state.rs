use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration as StdDuration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use market_common::{
    AdjustSeedStockRequest, AdjustSeedStockResponse, AdjustSeedStocksRequest, CacheRebuildResponse,
    DiagnosticsResponse, FillOrderRequest, FillOrderResponse, GetSeedStocksRequest,
    HistoryResponse, HistoryRow, MANIFEST_KEY, MarketManifest, MarketOrderEvent,
    ModifyOrderRequest, ModifyOrderResponse, OrderBookResponse, OrderRow, OwnerOrderRow,
    PlaceOrderRequest, PlaceOrderResponse, RecordTradeRequest, RecordTradeResponse, SCHEMA_SQL,
    SeedStockRow, SummaryRow, SweepExpiredOrdersResponse, now_rfc3339, seed_buy_order_id,
    seed_sell_order_id, try_decode_seed_buy_order_id,
};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use time::OffsetDateTime;
use tokio::sync::RwLock;

use crate::config::MarketServerConfig;

type SummaryCache = Arc<RwLock<HashMap<u32, Arc<Vec<SummaryRow>>>>>;
type StationSummaryCache = Arc<RwLock<HashMap<u64, Arc<Vec<SummaryRow>>>>>;
type OrderBookCache = Arc<RwLock<HashMap<(u32, u32), Arc<OrderBookResponse>>>>;

#[derive(Debug, Clone)]
pub struct StartupOverview {
    pub region_summary_cache_regions: usize,
    pub region_summary_rows: usize,
    pub price_history_rows: u64,
    pub total_orders: u64,
    pub open_orders: u64,
    pub open_buy_orders: u64,
    pub open_sell_orders: u64,
    pub closed_orders: u64,
    pub order_event_rows: u64,
}

pub type StartupProgressSink = Arc<dyn Fn(StartupProgressUpdate) + Send + Sync>;

#[derive(Debug, Clone)]
pub struct StartupProgressUpdate {
    pub phase_label: &'static str,
    pub percent_complete: f64,
    pub detail: String,
    pub elapsed: StdDuration,
    pub eta: Option<StdDuration>,
}

#[derive(Debug, Clone, Copy)]
enum StartupStage {
    Schema,
    Manifest,
    Summaries,
    Counts,
    Complete,
}

impl StartupStage {
    fn label(self) -> &'static str {
        match self {
            Self::Schema => "Schema",
            Self::Manifest => "Manifest",
            Self::Summaries => "Summaries",
            Self::Counts => "Counts",
            Self::Complete => "Ready",
        }
    }

    fn weight(self) -> f64 {
        match self {
            Self::Schema => 0.05,
            Self::Manifest => 0.05,
            Self::Summaries => 0.75,
            Self::Counts => 0.15,
            Self::Complete => 0.0,
        }
    }

    fn completed_weight_before(self) -> f64 {
        match self {
            Self::Schema => 0.0,
            Self::Manifest => 0.05,
            Self::Summaries => 0.10,
            Self::Counts => 0.85,
            Self::Complete => 1.0,
        }
    }
}

#[derive(Clone)]
struct StartupProgressTracker {
    sink: Option<StartupProgressSink>,
    started_at: Instant,
}

impl StartupProgressTracker {
    fn new(sink: Option<StartupProgressSink>) -> Self {
        Self {
            sink,
            started_at: Instant::now(),
        }
    }

    fn emit(&self, stage: StartupStage, stage_progress: f64, detail: impl Into<String>) {
        let Some(sink) = &self.sink else {
            return;
        };

        let percent_complete = if matches!(stage, StartupStage::Complete) {
            1.0
        } else {
            (stage.completed_weight_before() + (stage.weight() * stage_progress.clamp(0.0, 1.0)))
                .clamp(0.0, 0.999)
        };
        let elapsed = self.started_at.elapsed();
        let eta = if percent_complete > 0.001 && percent_complete < 1.0 {
            let total_seconds = elapsed.as_secs_f64() / percent_complete;
            Some(StdDuration::from_secs_f64(
                (total_seconds - elapsed.as_secs_f64()).max(0.0),
            ))
        } else {
            None
        };

        sink(StartupProgressUpdate {
            phase_label: stage.label(),
            percent_complete,
            detail: detail.into(),
            elapsed,
            eta,
        });
    }
}

impl ReadConnectionPool {
    fn new(database_path: &Path, config: &MarketServerConfig) -> Result<Self> {
        let connection_count = config.runtime.read_connection_pool_size.max(1);
        let tuning = ReadConnectionTuning {
            cache_size_kib: config.runtime.sqlite_read_cache_size_kib,
            mmap_size_bytes: config
                .runtime
                .sqlite_mmap_size_mb
                .saturating_mul(1024 * 1024),
            statement_cache_capacity: config.runtime.sqlite_statement_cache_capacity,
        };
        let mut connections = Vec::with_capacity(connection_count);
        for _ in 0..connection_count {
            connections.push(open_read_connection(database_path, &tuning)?);
        }

        Ok(Self {
            inner: Arc::new(ReadConnectionPoolInner {
                connections: Mutex::new(connections),
                available: Condvar::new(),
            }),
        })
    }

    fn acquire(&self) -> Result<ReadConnectionLease> {
        let mut guard = self
            .inner
            .connections
            .lock()
            .map_err(|_| anyhow!("read connection pool mutex poisoned"))?;
        loop {
            if let Some(connection) = guard.pop() {
                return Ok(ReadConnectionLease {
                    connection: Some(connection),
                    inner: Arc::clone(&self.inner),
                });
            }
            guard = self
                .inner
                .available
                .wait(guard)
                .map_err(|_| anyhow!("read connection pool wait failed"))?;
        }
    }
}

impl ReadConnectionLease {
    fn connection(&self) -> &Connection {
        self.connection
            .as_ref()
            .expect("read connection lease missing connection")
    }
}

impl Drop for ReadConnectionLease {
    fn drop(&mut self) {
        if let Some(connection) = self.connection.take() {
            if let Ok(mut guard) = self.inner.connections.lock() {
                guard.push(connection);
                self.inner.available.notify_one();
            }
        }
    }
}

#[derive(Clone)]
pub struct MarketRuntime {
    pub config: MarketServerConfig,
    pub database_path: Arc<PathBuf>,
    pub manifest: Arc<MarketManifest>,
    pub started_at: String,
    read_pool: Arc<ReadConnectionPool>,
    pub region_summaries: SummaryCache,
    pub system_seed_summaries: SummaryCache,
    pub system_summaries: SummaryCache,
    pub station_summaries: StationSummaryCache,
    pub order_books: OrderBookCache,
}

#[derive(Debug, Clone)]
struct StationMeta {
    station_id: u64,
    solar_system_id: u32,
    constellation_id: u32,
    region_id: u32,
}

#[derive(Debug, Clone)]
struct ReadConnectionTuning {
    cache_size_kib: i32,
    mmap_size_bytes: u64,
    statement_cache_capacity: usize,
}

#[derive(Debug)]
struct ReadConnectionPool {
    inner: Arc<ReadConnectionPoolInner>,
}

#[derive(Debug)]
struct ReadConnectionPoolInner {
    connections: Mutex<Vec<Connection>>,
    available: Condvar,
}

#[derive(Debug)]
struct ReadConnectionLease {
    connection: Option<Connection>,
    inner: Arc<ReadConnectionPoolInner>,
}

impl MarketRuntime {
    #[allow(dead_code)]
    pub async fn load(config: MarketServerConfig) -> Result<Self> {
        let (runtime, _) = Self::load_with_progress(config, None).await?;
        Ok(runtime)
    }

    pub async fn load_with_progress(
        config: MarketServerConfig,
        progress: Option<StartupProgressSink>,
    ) -> Result<(Self, StartupOverview)> {
        let database_path = config.storage.database_path.clone();
        if !database_path.exists() {
            bail!(
                "market database not found at {}. Run the market seeder first.",
                database_path.to_string_lossy()
            );
        }

        let tracker = StartupProgressTracker::new(progress);
        tracker.emit(StartupStage::Schema, 0.0, "schema");
        ensure_runtime_schema(Arc::new(database_path.clone())).await?;
        tracker.emit(StartupStage::Schema, 1.0, "schema ready");

        tracker.emit(StartupStage::Manifest, 0.0, "manifest");
        let manifest = load_manifest(database_path.clone()).await?;
        tracker.emit(
            StartupStage::Manifest,
            1.0,
            format!(
                "{} | {} reg | {} stn",
                manifest.selection_label,
                format_count(manifest.region_count),
                format_count(manifest.station_count)
            ),
        );

        tracker.emit(StartupStage::Summaries, 0.0, "preload");
        let region_summaries = load_all_region_summaries(
            database_path.clone(),
            manifest.region_count,
            tracker.clone(),
        )
        .await?;
        let system_seed_summaries = if config.runtime.preload_system_seed_summaries {
            load_all_system_seed_summaries(
                database_path.clone(),
                manifest.solar_system_count,
                tracker.clone(),
            )
            .await?
        } else {
            HashMap::new()
        };
        let read_pool = Arc::new(ReadConnectionPool::new(&database_path, &config)?);

        let runtime = Self {
            config,
            database_path: Arc::new(database_path),
            manifest: Arc::new(manifest),
            started_at: now_rfc3339(),
            read_pool,
            region_summaries: Arc::new(RwLock::new(region_summaries)),
            system_seed_summaries: Arc::new(RwLock::new(system_seed_summaries)),
            system_summaries: Arc::new(RwLock::new(HashMap::new())),
            station_summaries: Arc::new(RwLock::new(HashMap::new())),
            order_books: Arc::new(RwLock::new(HashMap::new())),
        };

        tracker.emit(StartupStage::Counts, 0.0, "Counting orders and history");
        let startup_overview = runtime
            .startup_overview_with_progress(tracker.clone())
            .await?;
        tracker.emit(
            StartupStage::Complete,
            1.0,
            format!(
                "{} rows | {} reg",
                format_count(startup_overview.region_summary_rows),
                format_count(startup_overview.region_summary_cache_regions)
            ),
        );

        Ok((runtime, startup_overview))
    }

    pub async fn get_region_summary(&self, region_id: u32) -> Result<Vec<SummaryRow>> {
        if let Some(rows) = self.region_summaries.read().await.get(&region_id).cloned() {
            return Ok((*rows).clone());
        }

        let read_pool = self.read_pool.clone();
        let rows = tokio::task::spawn_blocking(move || {
            let lease = read_pool.acquire()?;
            query_region_summary_rows_with_connection(lease.connection(), region_id)
        })
        .await
        .context("region summary task join failed")??;

        self.region_summaries
            .write()
            .await
            .insert(region_id, Arc::new(rows.clone()));
        Ok(rows)
    }

    pub async fn get_system_summary(&self, solar_system_id: u32) -> Result<Vec<SummaryRow>> {
        if let Some(rows) = self
            .system_summaries
            .read()
            .await
            .get(&solar_system_id)
            .cloned()
        {
            return Ok((*rows).clone());
        }

        let system_seed_rows = self
            .get_or_load_system_seed_summary_rows(solar_system_id)
            .await?;
        let read_pool = self.read_pool.clone();
        let rows = tokio::task::spawn_blocking(move || {
            let lease = read_pool.acquire()?;
            query_system_summary_rows_with_seed_base(
                lease.connection(),
                solar_system_id,
                system_seed_rows.as_deref().map(|rows| rows.as_slice()),
            )
        })
        .await
        .context("system summary task join failed")??;

        let mut cache = self.system_summaries.write().await;
        insert_bounded_summary_cache(
            &mut cache,
            solar_system_id,
            Arc::new(rows.clone()),
            self.config.runtime.system_summary_cache_capacity,
        );
        Ok(rows)
    }

    async fn get_or_load_system_seed_summary_rows(
        &self,
        solar_system_id: u32,
    ) -> Result<Option<Arc<Vec<SummaryRow>>>> {
        if let Some(rows) = self
            .system_seed_summaries
            .read()
            .await
            .get(&solar_system_id)
            .cloned()
        {
            return Ok(Some(rows));
        }

        let read_pool = self.read_pool.clone();
        let rows = tokio::task::spawn_blocking(move || {
            let lease = read_pool.acquire()?;
            query_seed_system_summary_rows_with_connection(lease.connection(), solar_system_id)
        })
        .await
        .context("system seed summary load task join failed")??;

        if rows.is_empty() {
            return Ok(None);
        }

        let rows = Arc::new(rows);
        let mut cache = self.system_seed_summaries.write().await;
        insert_bounded_summary_cache(
            &mut cache,
            solar_system_id,
            Arc::clone(&rows),
            self.config.runtime.system_summary_cache_capacity,
        );
        Ok(Some(rows))
    }

    pub async fn get_station_summary(&self, station_id: u64) -> Result<Vec<SummaryRow>> {
        if let Some(rows) = self
            .station_summaries
            .read()
            .await
            .get(&station_id)
            .cloned()
        {
            return Ok((*rows).clone());
        }

        let read_pool = self.read_pool.clone();
        let rows = tokio::task::spawn_blocking(move || {
            let lease = read_pool.acquire()?;
            query_summary_rows_for_scope(
                lease.connection(),
                "station_id",
                i64::try_from(station_id).unwrap_or(i64::MAX),
            )
        })
        .await
        .context("station summary task join failed")??;

        let mut cache = self.station_summaries.write().await;
        insert_bounded_station_summary_cache(
            &mut cache,
            station_id,
            Arc::new(rows.clone()),
            self.config.runtime.station_summary_cache_capacity,
        );
        Ok(rows)
    }

    pub async fn get_order_book(&self, region_id: u32, type_id: u32) -> Result<OrderBookResponse> {
        if let Some(response) = self
            .order_books
            .read()
            .await
            .get(&(region_id, type_id))
            .cloned()
        {
            return Ok((*response).clone());
        }

        let read_pool = self.read_pool.clone();
        let response = tokio::task::spawn_blocking(move || {
            let lease = read_pool.acquire()?;
            query_order_book_rows_with_connection(lease.connection(), region_id, type_id)
        })
        .await
        .context("order book task join failed")??;

        let mut cache = self.order_books.write().await;
        insert_bounded_order_book_cache(
            &mut cache,
            (region_id, type_id),
            Arc::new(response.clone()),
            self.config.runtime.order_book_cache_capacity,
        );
        Ok(response)
    }

    pub async fn get_history(&self, type_id: u32) -> Result<HistoryResponse> {
        let read_pool = self.read_pool.clone();
        tokio::task::spawn_blocking(move || {
            let lease = read_pool.acquire()?;
            query_history_rows_with_connection(lease.connection(), type_id)
        })
        .await
        .context("history task join failed")?
    }

    pub async fn get_histories(&self, type_ids: Vec<u32>) -> Result<Vec<HistoryResponse>> {
        let read_pool = self.read_pool.clone();
        tokio::task::spawn_blocking(move || {
            let lease = read_pool.acquire()?;
            query_many_history_rows_with_connection(lease.connection(), type_ids)
        })
        .await
        .context("many histories task join failed")?
    }

    pub async fn get_owner_orders(
        &self,
        owner_id: u64,
        is_corp: bool,
    ) -> Result<Vec<OwnerOrderRow>> {
        let read_pool = self.read_pool.clone();
        tokio::task::spawn_blocking(move || {
            let lease = read_pool.acquire()?;
            query_owner_orders_with_connection(lease.connection(), owner_id, is_corp)
        })
        .await
        .context("owner orders task join failed")?
    }

    pub async fn get_order(&self, order_id: i64) -> Result<OwnerOrderRow> {
        let read_pool = self.read_pool.clone();
        tokio::task::spawn_blocking(move || {
            let lease = read_pool.acquire()?;
            query_order_by_id_with_connection(lease.connection(), order_id)
        })
        .await
        .context("order task join failed")?
    }

    pub async fn get_order_events(
        &self,
        after_event_id: i64,
        event_type: Option<String>,
        limit: usize,
    ) -> Result<Vec<MarketOrderEvent>> {
        let read_pool = self.read_pool.clone();
        tokio::task::spawn_blocking(move || {
            let lease = read_pool.acquire()?;
            query_order_events_with_connection(
                lease.connection(),
                after_event_id,
                event_type,
                limit,
            )
        })
        .await
        .context("order events task join failed")?
    }

    pub async fn place_order(&self, request: PlaceOrderRequest) -> Result<PlaceOrderResponse> {
        let database_path = self.database_path.clone();
        let response = tokio::task::spawn_blocking(move || insert_order(&database_path, request))
            .await
            .context("place order task join failed")??;

        self.invalidate_scope_caches(
            response.region_id,
            response.solar_system_id,
            response.station_id,
            response.type_id,
        )
        .await;
        self.refresh_region_summary_row(response.region_id, response.type_id)
            .await?;
        Ok(response)
    }

    pub async fn modify_order(&self, request: ModifyOrderRequest) -> Result<ModifyOrderResponse> {
        let database_path = self.database_path.clone();
        let response =
            tokio::task::spawn_blocking(move || modify_order_in_db(&database_path, request))
                .await
                .context("modify order task join failed")??;

        if response.invalidated {
            self.invalidate_scope_caches(
                response.region_id,
                response.solar_system_id,
                response.station_id,
                response.type_id,
            )
            .await;
            self.refresh_region_summary_row(response.region_id, response.type_id)
                .await?;
        }

        Ok(response)
    }

    pub async fn cancel_order(&self, order_id: i64) -> Result<market_common::CancelOrderResponse> {
        let database_path = self.database_path.clone();
        let response =
            tokio::task::spawn_blocking(move || cancel_order_in_db(&database_path, order_id))
                .await
                .context("cancel order task join failed")??;

        if response.invalidated {
            let order = self.get_order(order_id).await?;
            self.invalidate_scope_caches(
                order.row.region_id,
                order.row.solar_system_id,
                order.row.station_id,
                order.row.type_id,
            )
            .await;
            self.refresh_region_summary_row(order.row.region_id, order.row.type_id)
                .await?;
        }

        Ok(response)
    }

    pub async fn cancel_station_orders(
        &self,
        station_id: u64,
    ) -> Result<market_common::CancelStationOrdersResponse> {
        let database_path = self.database_path.clone();
        let cancelled_orders = tokio::task::spawn_blocking(move || {
            cancel_station_orders_in_db(&database_path, station_id)
        })
        .await
        .context("cancel station orders task join failed")??;

        let mut summary_scopes = HashSet::<(u32, u32)>::new();
        for order in &cancelled_orders {
            self.invalidate_scope_caches(
                order.row.region_id,
                order.row.solar_system_id,
                order.row.station_id,
                order.row.type_id,
            )
            .await;
            summary_scopes.insert((order.row.region_id, order.row.type_id));
        }

        for (region_id, type_id) in summary_scopes {
            self.refresh_region_summary_row(region_id, type_id).await?;
        }

        Ok(market_common::CancelStationOrdersResponse {
            station_id,
            cancelled_count: cancelled_orders.len(),
            orders: cancelled_orders,
        })
    }

    pub async fn fill_order(&self, request: FillOrderRequest) -> Result<FillOrderResponse> {
        let database_path = self.database_path.clone();
        let response =
            tokio::task::spawn_blocking(move || fill_order_in_db(&database_path, request))
                .await
                .context("fill order task join failed")??;

        if response.invalidated {
            self.invalidate_scope_caches(
                response.region_id,
                response.solar_system_id,
                response.station_id,
                response.type_id,
            )
            .await;
            self.refresh_region_summary_row(response.region_id, response.type_id)
                .await?;
            if response.owner_id == 0 && response.bid {
                self.refresh_system_seed_summary_row(response.solar_system_id, response.type_id)
                    .await?;
            }
        }

        Ok(response)
    }

    pub async fn adjust_seed_stock(
        &self,
        request: AdjustSeedStockRequest,
    ) -> Result<AdjustSeedStockResponse> {
        let database_path = self.database_path.clone();
        let response =
            tokio::task::spawn_blocking(move || adjust_seed_stock_in_db(&database_path, request))
                .await
                .context("adjust seed stock task join failed")??;

        self.invalidate_scope_caches(
            response.region_id,
            response.solar_system_id,
            response.station_id,
            response.type_id,
        )
        .await;
        self.refresh_region_summary_row(response.region_id, response.type_id)
            .await?;
        self.refresh_system_seed_summary_row(response.solar_system_id, response.type_id)
            .await?;
        Ok(response)
    }

    pub async fn adjust_seed_stocks(
        &self,
        request: AdjustSeedStocksRequest,
    ) -> Result<Vec<AdjustSeedStockResponse>> {
        let database_path = self.database_path.clone();
        let responses =
            tokio::task::spawn_blocking(move || adjust_seed_stocks_in_db(&database_path, request))
                .await
                .context("adjust seed stocks task join failed")??;

        let region_ids = responses
            .iter()
            .filter(|row| row.applied)
            .map(|row| row.region_id)
            .collect::<HashSet<_>>();
        let system_ids = responses
            .iter()
            .filter(|row| row.applied)
            .map(|row| row.solar_system_id)
            .collect::<HashSet<_>>();
        let station_ids = responses
            .iter()
            .filter(|row| row.applied)
            .map(|row| row.station_id)
            .collect::<HashSet<_>>();
        let order_book_keys = responses
            .iter()
            .filter(|row| row.applied)
            .map(|row| (row.region_id, row.type_id))
            .collect::<HashSet<_>>();
        {
            let mut cache = self.region_summaries.write().await;
            for region_id in region_ids {
                cache.remove(&region_id);
            }
        }
        {
            let mut cache = self.system_summaries.write().await;
            for system_id in &system_ids {
                cache.remove(system_id);
            }
        }
        {
            let mut cache = self.system_seed_summaries.write().await;
            for system_id in system_ids {
                cache.remove(&system_id);
            }
        }
        {
            let mut cache = self.station_summaries.write().await;
            for station_id in station_ids {
                cache.remove(&station_id);
            }
        }
        {
            let mut cache = self.order_books.write().await;
            for key in order_book_keys {
                cache.remove(&key);
            }
        }
        Ok(responses)
    }

    pub async fn get_seed_stocks(
        &self,
        request: GetSeedStocksRequest,
    ) -> Result<Vec<SeedStockRow>> {
        let database_path = self.database_path.clone();
        tokio::task::spawn_blocking(move || read_seed_stocks_in_db(&database_path, request))
            .await
            .context("get seed stocks task join failed")?
    }

    pub async fn record_trade(&self, request: RecordTradeRequest) -> Result<RecordTradeResponse> {
        let database_path = self.database_path.clone();
        tokio::task::spawn_blocking(move || record_trade_in_db(&database_path, request))
            .await
            .context("record trade task join failed")?
    }

    pub async fn sweep_expired_orders(&self) -> Result<SweepExpiredOrdersResponse> {
        let database_path = self.database_path.clone();
        let expired_orders =
            tokio::task::spawn_blocking(move || expire_due_orders_in_db(&database_path))
                .await
                .context("expire due orders task join failed")??;

        for order in &expired_orders {
            self.invalidate_scope_caches(
                order.row.region_id,
                order.row.solar_system_id,
                order.row.station_id,
                order.row.type_id,
            )
            .await;
        }

        for order in &expired_orders {
            self.refresh_region_summary_row(order.row.region_id, order.row.type_id)
                .await?;
        }

        Ok(SweepExpiredOrdersResponse {
            expired_count: expired_orders.len(),
            swept_at: now_rfc3339(),
        })
    }

    pub async fn rebuild_region_summaries(
        &self,
        region_id: Option<u32>,
    ) -> Result<CacheRebuildResponse> {
        let database_path = self.database_path.clone();
        let response = tokio::task::spawn_blocking(move || {
            rebuild_region_summary_cache(&database_path, region_id)
        })
        .await
        .context("region summary rebuild task join failed")??;

        match region_id {
            Some(region_id) => {
                self.region_summaries.write().await.remove(&region_id);
            }
            None => {
                let reloaded = load_all_region_summaries(
                    (*self.database_path).clone(),
                    self.manifest.region_count,
                    StartupProgressTracker::new(None),
                )
                .await?;
                *self.region_summaries.write().await = reloaded;
            }
        }

        Ok(response)
    }

    pub async fn diagnostics(&self) -> Result<DiagnosticsResponse> {
        let region_cache = self.region_summaries.read().await;
        let region_rows = region_cache.values().map(|rows| rows.len()).sum();

        Ok(DiagnosticsResponse {
            started_at: self.started_at.clone(),
            database_path: self.database_path.to_string_lossy().to_string(),
            host: self.config.network.host.clone(),
            port: self.config.network.port,
            rpc_enabled: self.config.rpc.enabled,
            rpc_host: self.config.rpc.host.clone(),
            rpc_port: self.config.rpc.port,
            region_summary_cache_regions: region_cache.len(),
            region_summary_rows: region_rows,
            system_summary_cache_entries: self.system_summaries.read().await.len(),
            station_summary_cache_entries: self.station_summaries.read().await.len(),
            order_book_cache_entries: self.order_books.read().await.len(),
            manifest: (*self.manifest).clone(),
        })
    }

    #[allow(dead_code)]
    pub async fn startup_overview(&self) -> Result<StartupOverview> {
        self.startup_overview_with_progress(StartupProgressTracker::new(None))
            .await
    }

    async fn startup_overview_with_progress(
        &self,
        tracker: StartupProgressTracker,
    ) -> Result<StartupOverview> {
        let region_cache = self.region_summaries.read().await;
        let region_summary_cache_regions = region_cache.len();
        let region_summary_rows = region_cache.values().map(|rows| rows.len()).sum();
        drop(region_cache);

        let database_path = self.database_path.clone();
        let database_counts =
            tokio::task::spawn_blocking(move || query_startup_counts(&database_path, tracker))
                .await
                .context("startup overview task join failed")??;

        Ok(StartupOverview {
            region_summary_cache_regions,
            region_summary_rows,
            price_history_rows: database_counts.price_history_rows,
            total_orders: database_counts.total_orders,
            open_orders: database_counts.open_orders,
            open_buy_orders: database_counts.open_buy_orders,
            open_sell_orders: database_counts.open_sell_orders,
            closed_orders: database_counts.closed_orders,
            order_event_rows: database_counts.order_event_rows,
        })
    }

    async fn refresh_region_summary_row(&self, region_id: u32, type_id: u32) -> Result<()> {
        let database_path = self.database_path.clone();
        tokio::task::spawn_blocking(move || {
            refresh_single_region_summary_row(&database_path, region_id, type_id)
        })
        .await
        .context("refresh region summary row task join failed")??;
        self.region_summaries.write().await.remove(&region_id);
        Ok(())
    }

    async fn refresh_system_seed_summary_row(
        &self,
        solar_system_id: u32,
        type_id: u32,
    ) -> Result<()> {
        let database_path = self.database_path.clone();
        tokio::task::spawn_blocking(move || {
            refresh_single_system_seed_summary_row(&database_path, solar_system_id, type_id)
        })
        .await
        .context("refresh system seed summary row task join failed")??;
        self.system_seed_summaries
            .write()
            .await
            .remove(&solar_system_id);
        self.system_summaries.write().await.remove(&solar_system_id);
        Ok(())
    }

    async fn invalidate_scope_caches(
        &self,
        region_id: u32,
        solar_system_id: u32,
        station_id: u64,
        type_id: u32,
    ) {
        self.region_summaries.write().await.remove(&region_id);
        self.system_summaries.write().await.remove(&solar_system_id);
        self.station_summaries.write().await.remove(&station_id);
        self.order_books.write().await.remove(&(region_id, type_id));
    }
}

fn insert_bounded_summary_cache(
    cache: &mut HashMap<u32, Arc<Vec<SummaryRow>>>,
    key: u32,
    value: Arc<Vec<SummaryRow>>,
    capacity: usize,
) {
    if capacity > 0 && !cache.contains_key(&key) && cache.len() >= capacity {
        if let Some(evicted_key) = cache.keys().next().copied() {
            cache.remove(&evicted_key);
        }
    }
    cache.insert(key, value);
}

fn insert_bounded_station_summary_cache(
    cache: &mut HashMap<u64, Arc<Vec<SummaryRow>>>,
    key: u64,
    value: Arc<Vec<SummaryRow>>,
    capacity: usize,
) {
    if capacity > 0 && !cache.contains_key(&key) && cache.len() >= capacity {
        if let Some(evicted_key) = cache.keys().next().copied() {
            cache.remove(&evicted_key);
        }
    }
    cache.insert(key, value);
}

fn insert_bounded_order_book_cache(
    cache: &mut HashMap<(u32, u32), Arc<OrderBookResponse>>,
    key: (u32, u32),
    value: Arc<OrderBookResponse>,
    capacity: usize,
) {
    if capacity > 0 && !cache.contains_key(&key) && cache.len() >= capacity {
        if let Some(evicted_key) = cache.keys().next().copied() {
            cache.remove(&evicted_key);
        }
    }
    cache.insert(key, value);
}

fn load_connection(path: &Path) -> Result<Connection> {
    let connection = Connection::open(path).with_context(|| {
        format!(
            "failed to open market database at {}",
            path.to_string_lossy()
        )
    })?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    connection.pragma_update(None, "cache_size", -20_000)?;
    connection.pragma_update(None, "temp_store", "MEMORY")?;
    connection.busy_timeout(StdDuration::from_secs(5))?;
    connection.set_prepared_statement_cache_capacity(128);
    Ok(connection)
}

fn open_read_connection(path: &Path, tuning: &ReadConnectionTuning) -> Result<Connection> {
    let connection = Connection::open(path).with_context(|| {
        format!(
            "failed to open market database at {}",
            path.to_string_lossy()
        )
    })?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    connection.pragma_update(None, "cache_size", -tuning.cache_size_kib)?;
    connection.pragma_update(None, "temp_store", "MEMORY")?;
    connection.pragma_update(None, "query_only", 1)?;
    connection.pragma_update(None, "mmap_size", tuning.mmap_size_bytes)?;
    connection.busy_timeout(StdDuration::from_secs(5))?;
    connection.set_prepared_statement_cache_capacity(tuning.statement_cache_capacity);
    Ok(connection)
}

async fn ensure_runtime_schema(database_path: Arc<PathBuf>) -> Result<()> {
    tokio::task::spawn_blocking(move || {
        let connection = load_connection(&database_path)?;
        connection.execute_batch(SCHEMA_SQL)?;

        let mut has_last_state_change_at = false;
        {
            let mut statement = connection.prepare("PRAGMA table_info(market_orders)")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
            for row in rows {
                if row?.as_str() == "last_state_change_at" {
                    has_last_state_change_at = true;
                    break;
                }
            }
        }

        if !has_last_state_change_at {
            connection.execute(
                "ALTER TABLE market_orders ADD COLUMN last_state_change_at TEXT",
                [],
            )?;
        }

        connection.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_seed_stock_station_type_price
               ON seed_stock (station_id, type_id, price);
              CREATE INDEX IF NOT EXISTS idx_market_orders_station_type_bid_state_price
               ON market_orders (station_id, type_id, bid, state, price);
             CREATE INDEX IF NOT EXISTS idx_market_orders_player_expiry
               ON market_orders (state, issued_at, duration_days, order_id)
               WHERE source = 'player';
              CREATE TABLE IF NOT EXISTS market_order_events (
                event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type TEXT NOT NULL,
               order_id INTEGER NOT NULL,
               owner_id INTEGER NOT NULL,
               is_corp INTEGER NOT NULL DEFAULT 0,
               state TEXT NOT NULL,
               source TEXT NOT NULL,
               price REAL NOT NULL,
               vol_remaining INTEGER NOT NULL,
               type_id INTEGER NOT NULL,
               range_value INTEGER NOT NULL,
               vol_entered INTEGER NOT NULL,
               min_volume INTEGER NOT NULL DEFAULT 1,
               bid INTEGER NOT NULL,
               issued_at TEXT NOT NULL,
               duration_days INTEGER NOT NULL DEFAULT 90,
               station_id INTEGER NOT NULL,
               region_id INTEGER NOT NULL,
               solar_system_id INTEGER NOT NULL,
               constellation_id INTEGER NOT NULL,
               last_state_change_at TEXT,
               occurred_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_market_order_events_type_id
               ON market_order_events (event_type, event_id);",
        )?;
        Ok::<(), anyhow::Error>(())
    })
    .await
    .context("runtime schema creation task join failed")?
}

async fn load_manifest(database_path: PathBuf) -> Result<MarketManifest> {
    tokio::task::spawn_blocking(move || {
        let connection = load_connection(&database_path)?;
        let raw = connection
            .query_row(
                "SELECT value FROM manifest WHERE key = ?1",
                params![MANIFEST_KEY],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| anyhow!("manifest_json missing from market database"))?;
        let manifest = serde_json::from_str::<MarketManifest>(&raw)?;
        Ok(manifest)
    })
    .await
    .context("manifest load task join failed")?
}

async fn load_all_region_summaries(
    database_path: PathBuf,
    expected_region_count: u32,
    tracker: StartupProgressTracker,
) -> Result<HashMap<u32, Arc<Vec<SummaryRow>>>> {
    tokio::task::spawn_blocking(move || {
        let connection = load_connection(&database_path)?;
        let total_rows =
            connection.query_row("SELECT COUNT(*) FROM region_summaries", [], |row| {
                row.get::<_, u64>(0)
            })?;
        let mut statement = connection.prepare(
            "SELECT region_id, type_id, best_ask_price, total_ask_quantity, best_ask_station_id,
                    best_bid_price, total_bid_quantity, best_bid_station_id
             FROM region_summaries
             ORDER BY region_id, type_id",
        )?;

        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, u32>(0)?,
                SummaryRow {
                    type_id: row.get(1)?,
                    best_ask_price: row.get(2)?,
                    total_ask_quantity: row.get::<_, u64>(3)?,
                    best_ask_station_id: row.get(4)?,
                    best_bid_price: row.get(5)?,
                    total_bid_quantity: row.get::<_, u64>(6)?,
                    best_bid_station_id: row.get(7)?,
                },
            ))
        })?;

        let mut grouped: HashMap<u32, Vec<SummaryRow>> = HashMap::new();
        let mut loaded_rows: u64 = 0;
        let mut loaded_regions: u32 = 0;
        let mut current_region_id: Option<u32> = None;

        if total_rows == 0 {
            tracker.emit(StartupStage::Summaries, 1.0, "0 rows");
        }

        for row in rows {
            let (region_id, summary) = row?;
            if current_region_id != Some(region_id) {
                current_region_id = Some(region_id);
                loaded_regions += 1;
            }
            loaded_rows += 1;
            grouped.entry(region_id).or_default().push(summary);

            if total_rows > 0
                && (loaded_rows == 1
                    || loaded_rows == total_rows
                    || loaded_rows % 50_000 == 0
                    || grouped
                        .get(&region_id)
                        .map(|rows| rows.len() == 1)
                        .unwrap_or(false))
            {
                tracker.emit(
                    StartupStage::Summaries,
                    loaded_rows as f64 / total_rows as f64,
                    format!(
                        "rows {}/{} | reg {}/{}",
                        format_count(loaded_rows),
                        format_count(total_rows),
                        format_count(loaded_regions),
                        format_count(expected_region_count)
                    ),
                );
            }
        }

        tracker.emit(
            StartupStage::Summaries,
            1.0,
            format!(
                "rows {} | reg {}",
                format_count(loaded_rows),
                format_count(grouped.len())
            ),
        );

        Ok(grouped
            .into_iter()
            .map(|(region_id, rows)| (region_id, Arc::new(rows)))
            .collect::<HashMap<_, _>>())
    })
    .await
    .context("region summary preload task join failed")?
}

async fn load_all_system_seed_summaries(
    database_path: PathBuf,
    expected_system_count: u32,
    tracker: StartupProgressTracker,
) -> Result<HashMap<u32, Arc<Vec<SummaryRow>>>> {
    tokio::task::spawn_blocking(move || {
        let connection = load_connection(&database_path)?;
        let total_rows = connection.query_row(
            "SELECT COUNT(*) FROM system_seed_summaries",
            [],
            |row| row.get::<_, u64>(0),
        )?;
        let mut statement = connection.prepare(
            "SELECT solar_system_id, type_id, best_ask_price, total_ask_quantity, best_ask_station_id,
                    best_bid_price, total_bid_quantity, best_bid_station_id
             FROM system_seed_summaries
             ORDER BY solar_system_id, type_id",
        )?;

        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, u32>(0)?,
                SummaryRow {
                    type_id: row.get(1)?,
                    best_ask_price: row.get(2)?,
                    total_ask_quantity: row.get::<_, u64>(3)?,
                    best_ask_station_id: row.get(4)?,
                    best_bid_price: row.get(5)?,
                    total_bid_quantity: row.get::<_, u64>(6)?,
                    best_bid_station_id: row.get(7)?,
                },
            ))
        })?;

        let mut grouped: HashMap<u32, Vec<SummaryRow>> = HashMap::new();
        let mut loaded_rows: u64 = 0;
        let mut loaded_systems: u32 = 0;
        let mut current_system_id: Option<u32> = None;

        for row in rows {
            let (solar_system_id, summary) = row?;
            if current_system_id != Some(solar_system_id) {
                current_system_id = Some(solar_system_id);
                loaded_systems += 1;
            }
            loaded_rows += 1;
            grouped.entry(solar_system_id).or_default().push(summary);

            if total_rows > 0
                && (loaded_rows == total_rows
                    || loaded_rows % 100_000 == 0
                    || grouped
                        .get(&solar_system_id)
                        .map(|rows| rows.len() == 1)
                        .unwrap_or(false))
            {
                tracker.emit(
                    StartupStage::Summaries,
                    loaded_rows as f64 / total_rows as f64,
                    format!(
                        "sys rows {}/{} | sys {}/{}",
                        format_count(loaded_rows),
                        format_count(total_rows),
                        format_count(loaded_systems),
                        format_count(expected_system_count)
                    ),
                );
            }
        }

        Ok(grouped
            .into_iter()
            .map(|(solar_system_id, rows)| (solar_system_id, Arc::new(rows)))
            .collect::<HashMap<_, _>>())
    })
    .await
    .context("system seed summary preload task join failed")?
}

fn query_region_summary_rows_with_connection(
    connection: &Connection,
    region_id: u32,
) -> Result<Vec<SummaryRow>> {
    let mut statement = connection.prepare_cached(
        "SELECT type_id, best_ask_price, total_ask_quantity, best_ask_station_id,
                best_bid_price, total_bid_quantity, best_bid_station_id
         FROM region_summaries
         WHERE region_id = ?1
         ORDER BY type_id",
    )?;
    let rows = statement.query_map(params![region_id], |row| {
        Ok(SummaryRow {
            type_id: row.get(0)?,
            best_ask_price: row.get(1)?,
            total_ask_quantity: row.get::<_, u64>(2)?,
            best_ask_station_id: row.get(3)?,
            best_bid_price: row.get(4)?,
            total_bid_quantity: row.get::<_, u64>(5)?,
            best_bid_station_id: row.get(6)?,
        })
    })?;

    let mut result = Vec::new();
    for row in rows {
        result.push(row?);
    }
    Ok(result)
}

fn query_summary_rows_for_scope(
    connection: &Connection,
    scope_column: &str,
    scope_value: i64,
) -> Result<Vec<SummaryRow>> {
    match scope_column {
        "station_id" => {
            return query_station_summary_rows(connection, u64::try_from(scope_value).unwrap_or(0));
        }
        "solar_system_id" => {
            return query_system_summary_rows(connection, u32::try_from(scope_value).unwrap_or(0));
        }
        _ => {}
    }

    let sells_sql = format!(
        "WITH sells AS (
           SELECT type_id, price, quantity AS quantity_value, station_id
           FROM seed_stock
           WHERE {scope_column} = ?1 AND quantity > 0
           UNION ALL
           SELECT type_id, price, vol_remaining AS quantity_value, station_id
           FROM market_orders
           WHERE {scope_column} = ?1 AND state = 'open' AND bid = 0 AND vol_remaining > 0
         ),
         sell_totals AS (
           SELECT type_id,
                  MIN(price) AS best_ask_price,
                  SUM(quantity_value) AS total_ask_quantity
           FROM sells
           GROUP BY type_id
         )
         SELECT sell_totals.type_id,
                sell_totals.best_ask_price,
                sell_totals.total_ask_quantity,
                MIN(sells.station_id) AS best_ask_station_id
         FROM sell_totals
         JOIN sells
           ON sells.type_id = sell_totals.type_id
          AND sells.price = sell_totals.best_ask_price
         GROUP BY
           sell_totals.type_id,
           sell_totals.best_ask_price,
           sell_totals.total_ask_quantity
         ORDER BY sell_totals.type_id"
    );

    let buys_sql = format!(
        "WITH buys AS (
           SELECT type_id, price, quantity AS quantity_value, station_id
           FROM seed_buy_orders
           WHERE {scope_column} = ?1 AND quantity > 0
           UNION ALL
           SELECT type_id, price, vol_remaining AS quantity_value, station_id
           FROM market_orders
           WHERE {scope_column} = ?1 AND state = 'open' AND bid = 1 AND source = 'player' AND vol_remaining > 0
         ),
         buy_totals AS (
           SELECT type_id,
                  MAX(price) AS best_bid_price,
                  SUM(quantity_value) AS total_bid_quantity
           FROM buys
           GROUP BY type_id
         )
         SELECT buy_totals.type_id,
                buy_totals.best_bid_price,
                buy_totals.total_bid_quantity,
                MIN(buys.station_id) AS best_bid_station_id
         FROM buy_totals
         JOIN buys
           ON buys.type_id = buy_totals.type_id
          AND buys.price = buy_totals.best_bid_price
         GROUP BY
           buy_totals.type_id,
           buy_totals.best_bid_price,
           buy_totals.total_bid_quantity"
    );

    let mut result = HashMap::<u32, SummaryRow>::new();

    {
        let mut statement = connection.prepare_cached(&sells_sql)?;
        let rows = statement.query_map(params![scope_value], |row| {
            Ok((
                row.get::<_, u32>(0)?,
                row.get::<_, Option<f64>>(1)?,
                row.get::<_, u64>(2)?,
                row.get::<_, Option<u64>>(3)?,
            ))
        })?;

        for row in rows {
            let (type_id, best_ask_price, total_ask_quantity, best_ask_station_id) = row?;
            result.insert(
                type_id,
                SummaryRow {
                    type_id,
                    best_ask_price,
                    total_ask_quantity,
                    best_ask_station_id,
                    best_bid_price: None,
                    total_bid_quantity: 0,
                    best_bid_station_id: None,
                },
            );
        }
    }

    {
        let mut statement = connection.prepare_cached(&buys_sql)?;
        let rows = statement.query_map(params![scope_value], |row| {
            Ok((
                row.get::<_, u32>(0)?,
                row.get::<_, Option<f64>>(1)?,
                row.get::<_, u64>(2)?,
                row.get::<_, Option<u64>>(3)?,
            ))
        })?;

        for row in rows {
            let (type_id, best_bid_price, total_bid_quantity, best_bid_station_id) = row?;
            let entry = result.entry(type_id).or_insert_with(|| SummaryRow {
                type_id,
                best_ask_price: None,
                total_ask_quantity: 0,
                best_ask_station_id: None,
                best_bid_price: None,
                total_bid_quantity: 0,
                best_bid_station_id: None,
            });
            entry.best_bid_price = best_bid_price;
            entry.total_bid_quantity = total_bid_quantity;
            entry.best_bid_station_id = best_bid_station_id;
        }
    }

    let mut values = result.into_values().collect::<Vec<_>>();
    values.sort_by_key(|row| row.type_id);
    Ok(values)
}

fn query_station_summary_rows(connection: &Connection, station_id: u64) -> Result<Vec<SummaryRow>> {
    let mut result = HashMap::<u32, SummaryRow>::new();

    {
        let mut statement = connection.prepare_cached(
            "SELECT type_id, price, quantity
             FROM seed_stock
             WHERE station_id = ?1 AND quantity > 0
             ORDER BY type_id",
        )?;
        let rows = statement.query_map(params![station_id], |row| {
            Ok((
                row.get::<_, u32>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, u64>(2)?,
            ))
        })?;

        for row in rows {
            let (type_id, price, quantity) = row?;
            result.insert(
                type_id,
                SummaryRow {
                    type_id,
                    best_ask_price: Some(price),
                    total_ask_quantity: quantity,
                    best_ask_station_id: Some(station_id),
                    best_bid_price: None,
                    total_bid_quantity: 0,
                    best_bid_station_id: None,
                },
            );
        }
    }

    {
        let mut statement = connection.prepare_cached(
            "SELECT type_id, MIN(price) AS best_ask_price, SUM(vol_remaining) AS total_ask_quantity
             FROM market_orders
             WHERE station_id = ?1 AND state = 'open' AND bid = 0 AND source = 'player' AND vol_remaining > 0
             GROUP BY type_id",
        )?;
        let rows = statement.query_map(params![station_id], |row| {
            Ok((
                row.get::<_, u32>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, u64>(2)?,
            ))
        })?;

        for row in rows {
            let (type_id, best_ask_price, total_ask_quantity) = row?;
            let entry = result.entry(type_id).or_insert_with(|| SummaryRow {
                type_id,
                best_ask_price: None,
                total_ask_quantity: 0,
                best_ask_station_id: None,
                best_bid_price: None,
                total_bid_quantity: 0,
                best_bid_station_id: None,
            });
            entry.total_ask_quantity += total_ask_quantity;
            if entry
                .best_ask_price
                .is_none_or(|current| best_ask_price < current)
            {
                entry.best_ask_price = Some(best_ask_price);
                entry.best_ask_station_id = Some(station_id);
            }
        }
    }

    {
        let mut statement = connection.prepare_cached(
            "SELECT type_id, MAX(price) AS best_bid_price, SUM(quantity_value) AS total_bid_quantity
             FROM (
               SELECT type_id, price, quantity AS quantity_value
               FROM seed_buy_orders
               WHERE station_id = ?1 AND quantity > 0
               UNION ALL
               SELECT type_id, price, vol_remaining AS quantity_value
               FROM market_orders
               WHERE station_id = ?1 AND state = 'open' AND bid = 1 AND source = 'player' AND vol_remaining > 0
             )
             GROUP BY type_id",
        )?;
        let rows = statement.query_map(params![station_id], |row| {
            Ok((
                row.get::<_, u32>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, u64>(2)?,
            ))
        })?;

        for row in rows {
            let (type_id, best_bid_price, total_bid_quantity) = row?;
            let entry = result.entry(type_id).or_insert_with(|| SummaryRow {
                type_id,
                best_ask_price: None,
                total_ask_quantity: 0,
                best_ask_station_id: None,
                best_bid_price: None,
                total_bid_quantity: 0,
                best_bid_station_id: None,
            });
            entry.best_bid_price = Some(best_bid_price);
            entry.total_bid_quantity = total_bid_quantity;
            entry.best_bid_station_id = Some(station_id);
        }
    }

    let mut values = result.into_values().collect::<Vec<_>>();
    values.sort_by_key(|row| row.type_id);
    Ok(values)
}

fn query_system_summary_rows(
    connection: &Connection,
    solar_system_id: u32,
) -> Result<Vec<SummaryRow>> {
    let mut result = load_seed_system_summary_rows(connection, solar_system_id)?;
    if result.is_empty() {
        return query_system_summary_rows_fallback(connection, solar_system_id);
    }

    {
        let mut statement = connection.prepare_cached(
            "WITH sell_agg AS (
               SELECT type_id, MIN(price) AS best_ask_price, SUM(vol_remaining) AS total_ask_quantity
               FROM market_orders
               WHERE solar_system_id = ?1 AND state = 'open' AND bid = 0 AND source = 'player' AND vol_remaining > 0
               GROUP BY type_id
             )
             SELECT sell_agg.type_id,
                    sell_agg.best_ask_price,
                    sell_agg.total_ask_quantity,
                    MIN(market_orders.station_id) AS best_ask_station_id
             FROM sell_agg
             JOIN market_orders
               ON market_orders.solar_system_id = ?1
              AND market_orders.type_id = sell_agg.type_id
              AND market_orders.price = sell_agg.best_ask_price
              AND market_orders.state = 'open'
              AND market_orders.bid = 0
              AND market_orders.source = 'player'
              AND market_orders.vol_remaining > 0
             GROUP BY sell_agg.type_id, sell_agg.best_ask_price, sell_agg.total_ask_quantity",
        )?;
        let rows = statement.query_map(params![solar_system_id], |row| {
            Ok((
                row.get::<_, u32>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, u64>(2)?,
                row.get::<_, u64>(3)?,
            ))
        })?;

        for row in rows {
            let (type_id, best_ask_price, total_ask_quantity, best_ask_station_id) = row?;
            let entry = result.entry(type_id).or_insert_with(|| SummaryRow {
                type_id,
                best_ask_price: None,
                total_ask_quantity: 0,
                best_ask_station_id: None,
                best_bid_price: None,
                total_bid_quantity: 0,
                best_bid_station_id: None,
            });
            entry.total_ask_quantity += total_ask_quantity;
            if entry
                .best_ask_price
                .is_none_or(|current| best_ask_price < current)
                || (entry.best_ask_price == Some(best_ask_price)
                    && entry
                        .best_ask_station_id
                        .map(|current| best_ask_station_id < current)
                        .unwrap_or(true))
            {
                entry.best_ask_price = Some(best_ask_price);
                entry.best_ask_station_id = Some(best_ask_station_id);
            }
        }
    }

    {
        let mut statement = connection.prepare_cached(
            "WITH buy_agg AS (
               SELECT type_id, MAX(price) AS best_bid_price, SUM(vol_remaining) AS total_bid_quantity
               FROM market_orders
               WHERE solar_system_id = ?1 AND state = 'open' AND bid = 1 AND source = 'player' AND vol_remaining > 0
               GROUP BY type_id
             )
             SELECT buy_agg.type_id,
                    buy_agg.best_bid_price,
                    buy_agg.total_bid_quantity,
                    MIN(market_orders.station_id) AS best_bid_station_id
             FROM buy_agg
             JOIN market_orders
               ON market_orders.solar_system_id = ?1
              AND market_orders.type_id = buy_agg.type_id
              AND market_orders.price = buy_agg.best_bid_price
              AND market_orders.state = 'open'
              AND market_orders.bid = 1
              AND market_orders.source = 'player'
              AND market_orders.vol_remaining > 0
             GROUP BY buy_agg.type_id, buy_agg.best_bid_price, buy_agg.total_bid_quantity",
        )?;
        let rows = statement.query_map(params![solar_system_id], |row| {
            Ok((
                row.get::<_, u32>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, u64>(2)?,
                row.get::<_, u64>(3)?,
            ))
        })?;

        for row in rows {
            let (type_id, best_bid_price, total_bid_quantity, best_bid_station_id) = row?;
            let entry = result.entry(type_id).or_insert_with(|| SummaryRow {
                type_id,
                best_ask_price: None,
                total_ask_quantity: 0,
                best_ask_station_id: None,
                best_bid_price: None,
                total_bid_quantity: 0,
                best_bid_station_id: None,
            });
            entry.best_bid_price = Some(best_bid_price);
            entry.total_bid_quantity += total_bid_quantity;
            entry.best_bid_station_id = Some(best_bid_station_id);
        }
    }

    let mut values = result.into_values().collect::<Vec<_>>();
    values.sort_by_key(|row| row.type_id);
    Ok(values)
}

fn query_system_summary_rows_with_seed_base(
    connection: &Connection,
    solar_system_id: u32,
    seed_rows: Option<&[SummaryRow]>,
) -> Result<Vec<SummaryRow>> {
    if let Some(seed_rows) = seed_rows {
        let mut result = seed_rows
            .iter()
            .cloned()
            .map(|row| (row.type_id, row))
            .collect::<HashMap<_, _>>();

        {
            let mut statement = connection.prepare_cached(
                "WITH sell_agg AS (
                   SELECT type_id, MIN(price) AS best_ask_price, SUM(vol_remaining) AS total_ask_quantity
                   FROM market_orders
                   WHERE solar_system_id = ?1 AND state = 'open' AND bid = 0 AND source = 'player' AND vol_remaining > 0
                   GROUP BY type_id
                 )
                 SELECT sell_agg.type_id,
                        sell_agg.best_ask_price,
                        sell_agg.total_ask_quantity,
                        MIN(market_orders.station_id) AS best_ask_station_id
                 FROM sell_agg
                 JOIN market_orders
                   ON market_orders.solar_system_id = ?1
                  AND market_orders.type_id = sell_agg.type_id
                  AND market_orders.price = sell_agg.best_ask_price
                  AND market_orders.state = 'open'
                  AND market_orders.bid = 0
                  AND market_orders.source = 'player'
                  AND market_orders.vol_remaining > 0
                 GROUP BY sell_agg.type_id, sell_agg.best_ask_price, sell_agg.total_ask_quantity",
            )?;
            let rows = statement.query_map(params![solar_system_id], |row| {
                Ok((
                    row.get::<_, u32>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, u64>(2)?,
                    row.get::<_, u64>(3)?,
                ))
            })?;

            for row in rows {
                let (type_id, best_ask_price, total_ask_quantity, best_ask_station_id) = row?;
                let entry = result.entry(type_id).or_insert_with(|| SummaryRow {
                    type_id,
                    best_ask_price: None,
                    total_ask_quantity: 0,
                    best_ask_station_id: None,
                    best_bid_price: None,
                    total_bid_quantity: 0,
                    best_bid_station_id: None,
                });
                entry.total_ask_quantity += total_ask_quantity;
                if entry
                    .best_ask_price
                    .is_none_or(|current| best_ask_price < current)
                    || (entry.best_ask_price == Some(best_ask_price)
                        && entry
                            .best_ask_station_id
                            .map(|current| best_ask_station_id < current)
                            .unwrap_or(true))
                {
                    entry.best_ask_price = Some(best_ask_price);
                    entry.best_ask_station_id = Some(best_ask_station_id);
                }
            }
        }

        {
            let mut statement = connection.prepare_cached(
                "WITH buy_agg AS (
                   SELECT type_id, MAX(price) AS best_bid_price, SUM(vol_remaining) AS total_bid_quantity
                   FROM market_orders
                   WHERE solar_system_id = ?1 AND state = 'open' AND bid = 1 AND source = 'player' AND vol_remaining > 0
                   GROUP BY type_id
                 )
                 SELECT buy_agg.type_id,
                        buy_agg.best_bid_price,
                        buy_agg.total_bid_quantity,
                        MIN(market_orders.station_id) AS best_bid_station_id
                 FROM buy_agg
                 JOIN market_orders
                   ON market_orders.solar_system_id = ?1
                  AND market_orders.type_id = buy_agg.type_id
                  AND market_orders.price = buy_agg.best_bid_price
                  AND market_orders.state = 'open'
                  AND market_orders.bid = 1
                  AND market_orders.source = 'player'
                  AND market_orders.vol_remaining > 0
                 GROUP BY buy_agg.type_id, buy_agg.best_bid_price, buy_agg.total_bid_quantity",
            )?;
            let rows = statement.query_map(params![solar_system_id], |row| {
                Ok((
                    row.get::<_, u32>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, u64>(2)?,
                    row.get::<_, u64>(3)?,
                ))
            })?;

            for row in rows {
                let (type_id, best_bid_price, total_bid_quantity, best_bid_station_id) = row?;
                let entry = result.entry(type_id).or_insert_with(|| SummaryRow {
                    type_id,
                    best_ask_price: None,
                    total_ask_quantity: 0,
                    best_ask_station_id: None,
                    best_bid_price: None,
                    total_bid_quantity: 0,
                    best_bid_station_id: None,
                });
                entry.best_bid_price = Some(best_bid_price);
                entry.total_bid_quantity += total_bid_quantity;
                entry.best_bid_station_id = Some(best_bid_station_id);
            }
        }

        let mut values = result.into_values().collect::<Vec<_>>();
        values.sort_by_key(|row| row.type_id);
        return Ok(values);
    }

    query_system_summary_rows(connection, solar_system_id)
}

fn query_seed_system_summary_rows_with_connection(
    connection: &Connection,
    solar_system_id: u32,
) -> Result<Vec<SummaryRow>> {
    let mut statement = connection.prepare_cached(
        "SELECT type_id, best_ask_price, total_ask_quantity, best_ask_station_id,
                best_bid_price, total_bid_quantity, best_bid_station_id
         FROM system_seed_summaries
         WHERE solar_system_id = ?1
         ORDER BY type_id",
    )?;
    let rows = statement.query_map(params![solar_system_id], |row| {
        Ok(SummaryRow {
            type_id: row.get(0)?,
            best_ask_price: row.get(1)?,
            total_ask_quantity: row.get::<_, u64>(2)?,
            best_ask_station_id: row.get(3)?,
            best_bid_price: row.get(4)?,
            total_bid_quantity: row.get::<_, u64>(5)?,
            best_bid_station_id: row.get(6)?,
        })
    })?;

    let mut result = Vec::new();
    for row in rows {
        result.push(row?);
    }
    Ok(result)
}

fn load_seed_system_summary_rows(
    connection: &Connection,
    solar_system_id: u32,
) -> Result<HashMap<u32, SummaryRow>> {
    Ok(
        query_seed_system_summary_rows_with_connection(connection, solar_system_id)?
            .into_iter()
            .map(|row| (row.type_id, row))
            .collect::<HashMap<_, _>>(),
    )
}

fn query_system_summary_rows_fallback(
    connection: &Connection,
    solar_system_id: u32,
) -> Result<Vec<SummaryRow>> {
    let mut result = HashMap::<u32, SummaryRow>::new();

    {
        let mut statement = connection.prepare_cached(
            "WITH seed_agg AS (
               SELECT type_id, MIN(price) AS best_ask_price, SUM(quantity) AS total_ask_quantity
               FROM seed_stock
               WHERE solar_system_id = ?1 AND quantity > 0
               GROUP BY type_id
             )
             SELECT seed_agg.type_id,
                    seed_agg.best_ask_price,
                    seed_agg.total_ask_quantity,
                    MIN(seed_stock.station_id) AS best_ask_station_id
             FROM seed_agg
             JOIN seed_stock
               ON seed_stock.solar_system_id = ?1
              AND seed_stock.type_id = seed_agg.type_id
              AND seed_stock.price = seed_agg.best_ask_price
              AND seed_stock.quantity > 0
             GROUP BY seed_agg.type_id, seed_agg.best_ask_price, seed_agg.total_ask_quantity
             ORDER BY seed_agg.type_id",
        )?;
        let rows = statement.query_map(params![solar_system_id], |row| {
            Ok((
                row.get::<_, u32>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, u64>(2)?,
                row.get::<_, u64>(3)?,
            ))
        })?;

        for row in rows {
            let (type_id, best_ask_price, total_ask_quantity, best_ask_station_id) = row?;
            result.insert(
                type_id,
                SummaryRow {
                    type_id,
                    best_ask_price: Some(best_ask_price),
                    total_ask_quantity,
                    best_ask_station_id: Some(best_ask_station_id),
                    best_bid_price: None,
                    total_bid_quantity: 0,
                    best_bid_station_id: None,
                },
            );
        }
    }

    {
        let mut statement = connection.prepare_cached(
            "WITH sell_agg AS (
               SELECT type_id, MIN(price) AS best_ask_price, SUM(vol_remaining) AS total_ask_quantity
               FROM market_orders
               WHERE solar_system_id = ?1 AND state = 'open' AND bid = 0 AND source = 'player' AND vol_remaining > 0
               GROUP BY type_id
             )
             SELECT sell_agg.type_id,
                    sell_agg.best_ask_price,
                    sell_agg.total_ask_quantity,
                    MIN(market_orders.station_id) AS best_ask_station_id
             FROM sell_agg
             JOIN market_orders
               ON market_orders.solar_system_id = ?1
              AND market_orders.type_id = sell_agg.type_id
              AND market_orders.price = sell_agg.best_ask_price
              AND market_orders.state = 'open'
              AND market_orders.bid = 0
              AND market_orders.source = 'player'
              AND market_orders.vol_remaining > 0
             GROUP BY sell_agg.type_id, sell_agg.best_ask_price, sell_agg.total_ask_quantity",
        )?;
        let rows = statement.query_map(params![solar_system_id], |row| {
            Ok((
                row.get::<_, u32>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, u64>(2)?,
                row.get::<_, u64>(3)?,
            ))
        })?;

        for row in rows {
            let (type_id, best_ask_price, total_ask_quantity, best_ask_station_id) = row?;
            let entry = result.entry(type_id).or_insert_with(|| SummaryRow {
                type_id,
                best_ask_price: None,
                total_ask_quantity: 0,
                best_ask_station_id: None,
                best_bid_price: None,
                total_bid_quantity: 0,
                best_bid_station_id: None,
            });
            entry.total_ask_quantity += total_ask_quantity;
            if entry
                .best_ask_price
                .is_none_or(|current| best_ask_price < current)
                || (entry.best_ask_price == Some(best_ask_price)
                    && entry
                        .best_ask_station_id
                        .map(|current| best_ask_station_id < current)
                        .unwrap_or(true))
            {
                entry.best_ask_price = Some(best_ask_price);
                entry.best_ask_station_id = Some(best_ask_station_id);
            }
        }
    }

    {
        let mut statement = connection.prepare_cached(
            "WITH buy_agg AS (
               SELECT type_id, MAX(price) AS best_bid_price, SUM(quantity_value) AS total_bid_quantity
               FROM (
                 SELECT type_id, price, quantity AS quantity_value
                 FROM seed_buy_orders
                 WHERE solar_system_id = ?1 AND quantity > 0
                 UNION ALL
                 SELECT type_id, price, vol_remaining AS quantity_value
                 FROM market_orders
                 WHERE solar_system_id = ?1 AND state = 'open' AND bid = 1 AND source = 'player' AND vol_remaining > 0
               )
               GROUP BY type_id
             )
             SELECT buy_agg.type_id,
                    buy_agg.best_bid_price,
                    buy_agg.total_bid_quantity,
                    MIN(buy_rows.station_id) AS best_bid_station_id
             FROM buy_agg
             JOIN (
               SELECT type_id, station_id, price
               FROM seed_buy_orders
               WHERE solar_system_id = ?1 AND quantity > 0
               UNION ALL
               SELECT type_id, station_id, price
               FROM market_orders
               WHERE solar_system_id = ?1 AND state = 'open' AND bid = 1 AND source = 'player' AND vol_remaining > 0
             ) AS buy_rows
               ON buy_rows.type_id = buy_agg.type_id
              AND buy_rows.price = buy_agg.best_bid_price
             GROUP BY buy_agg.type_id, buy_agg.best_bid_price, buy_agg.total_bid_quantity",
        )?;
        let rows = statement.query_map(params![solar_system_id], |row| {
            Ok((
                row.get::<_, u32>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, u64>(2)?,
                row.get::<_, u64>(3)?,
            ))
        })?;

        for row in rows {
            let (type_id, best_bid_price, total_bid_quantity, best_bid_station_id) = row?;
            let entry = result.entry(type_id).or_insert_with(|| SummaryRow {
                type_id,
                best_ask_price: None,
                total_ask_quantity: 0,
                best_ask_station_id: None,
                best_bid_price: None,
                total_bid_quantity: 0,
                best_bid_station_id: None,
            });
            entry.best_bid_price = Some(best_bid_price);
            entry.total_bid_quantity = total_bid_quantity;
            entry.best_bid_station_id = Some(best_bid_station_id);
        }
    }

    let mut values = result.into_values().collect::<Vec<_>>();
    values.sort_by_key(|row| row.type_id);
    Ok(values)
}

fn query_order_book_rows_with_connection(
    connection: &Connection,
    region_id: u32,
    type_id: u32,
) -> Result<OrderBookResponse> {
    let mut sells = Vec::new();
    {
        let mut statement = connection.prepare_cached(
            "SELECT station_id, solar_system_id, constellation_id, price, quantity, initial_quantity, updated_at
             FROM seed_stock
             WHERE region_id = ?1 AND type_id = ?2 AND quantity > 0
             ORDER BY price ASC, station_id ASC",
        )?;
        let rows = statement.query_map(params![region_id, type_id], |row| {
            Ok(OrderRow {
                order_id: seed_sell_order_id(row.get::<_, u64>(0)?, type_id),
                price: row.get(3)?,
                vol_remaining: row.get::<_, u64>(4)?,
                type_id,
                range_value: 32_767,
                vol_entered: row.get::<_, u64>(5)?,
                min_volume: 1,
                bid: false,
                issued_at: row.get(6)?,
                duration_days: 3650,
                station_id: row.get(0)?,
                region_id,
                solar_system_id: row.get(1)?,
                constellation_id: row.get(2)?,
                source: "seed".to_string(),
            })
        })?;

        for row in rows {
            sells.push(row?);
        }
    }

    {
        let mut statement = connection.prepare_cached(
            "SELECT order_id, price, vol_remaining, vol_entered, min_volume, range_value, duration_days,
                    station_id, solar_system_id, constellation_id, issued_at, source
             FROM market_orders
             WHERE region_id = ?1 AND type_id = ?2 AND state = 'open' AND bid = 0 AND vol_remaining > 0
             ORDER BY price ASC, station_id ASC, order_id ASC",
        )?;
        let rows = statement.query_map(params![region_id, type_id], |row| {
            Ok(OrderRow {
                order_id: row.get(0)?,
                price: row.get(1)?,
                vol_remaining: row.get::<_, u64>(2)?,
                type_id,
                range_value: row.get(5)?,
                vol_entered: row.get::<_, u64>(3)?,
                min_volume: row.get::<_, u64>(4)?,
                bid: false,
                issued_at: row.get(10)?,
                duration_days: row.get(6)?,
                station_id: row.get(7)?,
                region_id,
                solar_system_id: row.get(8)?,
                constellation_id: row.get(9)?,
                source: row.get(11)?,
            })
        })?;

        for row in rows {
            sells.push(row?);
        }
    }

    sells.sort_by(|left, right| {
        left.price
            .partial_cmp(&right.price)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(left.station_id.cmp(&right.station_id))
            .then(left.order_id.cmp(&right.order_id))
    });

    let mut buys = Vec::new();
    {
        let mut statement = connection.prepare_cached(
            "SELECT station_id, solar_system_id, constellation_id, price, quantity, initial_quantity, updated_at
             FROM seed_buy_orders
             WHERE region_id = ?1 AND type_id = ?2 AND quantity > 0
             ORDER BY price DESC, station_id ASC",
        )?;
        let rows = statement.query_map(params![region_id, type_id], |row| {
            Ok(OrderRow {
                order_id: seed_buy_order_id(row.get::<_, u64>(0)?, type_id),
                price: row.get(3)?,
                vol_remaining: row.get::<_, u64>(4)?,
                type_id,
                range_value: 32_767,
                vol_entered: row.get::<_, u64>(5)?,
                min_volume: 1,
                bid: true,
                issued_at: row.get(6)?,
                duration_days: 3650,
                station_id: row.get(0)?,
                region_id,
                solar_system_id: row.get(1)?,
                constellation_id: row.get(2)?,
                source: "seed".to_string(),
            })
        })?;

        for row in rows {
            buys.push(row?);
        }
    }

    {
        let mut statement = connection.prepare_cached(
            "SELECT order_id, price, vol_remaining, vol_entered, min_volume, range_value, duration_days,
                    station_id, solar_system_id, constellation_id, issued_at, source
             FROM market_orders
             WHERE region_id = ?1 AND type_id = ?2 AND state = 'open' AND bid = 1 AND source = 'player' AND vol_remaining > 0
             ORDER BY price DESC, station_id ASC, order_id ASC",
        )?;
        let rows = statement.query_map(params![region_id, type_id], |row| {
            Ok(OrderRow {
                order_id: row.get(0)?,
                price: row.get(1)?,
                vol_remaining: row.get::<_, u64>(2)?,
                type_id,
                range_value: row.get(5)?,
                vol_entered: row.get::<_, u64>(3)?,
                min_volume: row.get::<_, u64>(4)?,
                bid: true,
                issued_at: row.get(10)?,
                duration_days: row.get(6)?,
                station_id: row.get(7)?,
                region_id,
                solar_system_id: row.get(8)?,
                constellation_id: row.get(9)?,
                source: row.get(11)?,
            })
        })?;

        for row in rows {
            buys.push(row?);
        }
    }

    Ok(OrderBookResponse {
        region_id,
        type_id,
        sells,
        buys,
        cached_at: now_rfc3339(),
    })
}

fn query_many_history_rows_with_connection(
    connection: &Connection,
    type_ids: Vec<u32>,
) -> Result<Vec<HistoryResponse>> {
    let mut responses = Vec::with_capacity(type_ids.len());
    for type_id in type_ids {
        responses.push(query_history_rows_with_connection(connection, type_id)?);
    }
    Ok(responses)
}

fn query_history_rows_with_connection(
    connection: &Connection,
    type_id: u32,
) -> Result<HistoryResponse> {
    let mut statement = connection.prepare_cached(
        "SELECT day, low_price, high_price, avg_price, volume, order_count
         FROM price_history
         WHERE type_id = ?1
         ORDER BY day ASC",
    )?;
    let rows = statement.query_map(params![type_id], |row| {
        Ok(HistoryRow {
            day: row.get(0)?,
            low_price: row.get(1)?,
            high_price: row.get(2)?,
            avg_price: row.get(3)?,
            volume: row.get::<_, u64>(4)?,
            order_count: row.get(5)?,
        })
    })?;

    let mut result_rows = Vec::new();
    for row in rows {
        result_rows.push(row?);
    }

    Ok(HistoryResponse {
        type_id,
        rows: result_rows,
    })
}

fn query_owner_orders_with_connection(
    connection: &Connection,
    owner_id: u64,
    is_corp: bool,
) -> Result<Vec<OwnerOrderRow>> {
    let mut statement = connection.prepare_cached(
        "SELECT order_id, owner_id, is_corp, state, source, price, vol_remaining, type_id, range_value,
                vol_entered, min_volume, bid, issued_at, duration_days, station_id, region_id,
                solar_system_id, constellation_id, last_state_change_at
         FROM market_orders
         WHERE owner_id = ?1 AND is_corp = ?2
         ORDER BY updated_at DESC, order_id DESC",
    )?;
    let rows = statement.query_map(
        params![owner_id, if is_corp { 1 } else { 0 }],
        map_owner_order_row,
    )?;

    let mut result = Vec::new();
    for row in rows {
        result.push(row?);
    }
    Ok(result)
}

fn query_order_by_id_with_connection(
    connection: &Connection,
    order_id: i64,
) -> Result<OwnerOrderRow> {
    if let Some((station_id, type_id)) = try_decode_seed_buy_order_id(order_id) {
        if let Some(order) =
            query_seed_buy_order_by_id_with_connection(connection, station_id, type_id)?
        {
            return Ok(order);
        }
    }

    connection
        .query_row(
            "SELECT order_id, owner_id, is_corp, state, source, price, vol_remaining, type_id, range_value,
                    vol_entered, min_volume, bid, issued_at, duration_days, station_id, region_id,
                    solar_system_id, constellation_id, last_state_change_at
             FROM market_orders
             WHERE order_id = ?1",
            params![order_id],
            map_owner_order_row,
        )
        .optional()?
        .ok_or_else(|| anyhow!("order {} not found", order_id))
}

fn query_order_events_with_connection(
    connection: &Connection,
    after_event_id: i64,
    event_type: Option<String>,
    limit: usize,
) -> Result<Vec<MarketOrderEvent>> {
    let limit = limit.max(1).min(1000) as i64;
    let mut result = Vec::new();

    if let Some(event_type) = event_type {
        let mut statement = connection.prepare_cached(
            "SELECT event_id, event_type, occurred_at, order_id, owner_id, is_corp, state, source,
                    price, vol_remaining, type_id, range_value, vol_entered, min_volume, bid,
                    issued_at, duration_days, station_id, region_id, solar_system_id,
                    constellation_id, last_state_change_at
             FROM market_order_events
             WHERE event_id > ?1 AND event_type = ?2
             ORDER BY event_id ASC
             LIMIT ?3",
        )?;
        let rows = statement.query_map(
            params![after_event_id, event_type, limit],
            map_market_order_event,
        )?;
        for row in rows {
            result.push(row?);
        }
    } else {
        let mut statement = connection.prepare_cached(
            "SELECT event_id, event_type, occurred_at, order_id, owner_id, is_corp, state, source,
                    price, vol_remaining, type_id, range_value, vol_entered, min_volume, bid,
                    issued_at, duration_days, station_id, region_id, solar_system_id,
                    constellation_id, last_state_change_at
             FROM market_order_events
             WHERE event_id > ?1
             ORDER BY event_id ASC
             LIMIT ?2",
        )?;
        let rows = statement.query_map(params![after_event_id, limit], map_market_order_event)?;
        for row in rows {
            result.push(row?);
        }
    }

    Ok(result)
}

#[derive(Debug)]
struct StartupCounts {
    price_history_rows: u64,
    total_orders: u64,
    open_orders: u64,
    open_buy_orders: u64,
    open_sell_orders: u64,
    closed_orders: u64,
    order_event_rows: u64,
}

fn query_startup_counts(
    database_path: &Path,
    tracker: StartupProgressTracker,
) -> Result<StartupCounts> {
    let connection = load_connection(database_path)?;
    let total_steps = 3.0;

    tracker.emit(StartupStage::Counts, 0.0, "history");
    let price_history_rows =
        connection.query_row("SELECT COUNT(*) FROM price_history", [], |row| {
            row.get::<_, u64>(0)
        })?;
    tracker.emit(
        StartupStage::Counts,
        1.0 / total_steps,
        format!("hist {}", format_count(price_history_rows)),
    );

    tracker.emit(StartupStage::Counts, 1.0 / total_steps, "orders");
    let (player_total_orders, player_open_orders, player_open_buy_orders, player_open_sell_orders) =
        connection.query_row(
            "SELECT
           COUNT(*) AS total_orders,
           SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END) AS open_orders,
           SUM(CASE WHEN state = 'open' AND bid = 1 THEN 1 ELSE 0 END) AS open_buy_orders,
           SUM(CASE WHEN state = 'open' AND bid = 0 THEN 1 ELSE 0 END) AS open_sell_orders
         FROM market_orders",
            [],
            |row| {
                Ok((
                    row.get::<_, u64>(0)?,
                    row.get::<_, Option<u64>>(1)?.unwrap_or(0),
                    row.get::<_, Option<u64>>(2)?.unwrap_or(0),
                    row.get::<_, Option<u64>>(3)?.unwrap_or(0),
                ))
            },
        )?;
    let (seed_buy_total_orders, seed_buy_open_orders) = connection.query_row(
        "SELECT
           COUNT(*) AS total_orders,
           SUM(CASE WHEN quantity > 0 THEN 1 ELSE 0 END) AS open_orders
         FROM seed_buy_orders",
        [],
        |row| {
            Ok((
                row.get::<_, u64>(0)?,
                row.get::<_, Option<u64>>(1)?.unwrap_or(0),
            ))
        },
    )?;
    let (seed_sell_total_orders, seed_sell_open_orders) = connection.query_row(
        "SELECT
           COUNT(*) AS total_orders,
           SUM(CASE WHEN quantity > 0 THEN 1 ELSE 0 END) AS open_orders
         FROM seed_stock",
        [],
        |row| {
            Ok((
                row.get::<_, u64>(0)?,
                row.get::<_, Option<u64>>(1)?.unwrap_or(0),
            ))
        },
    )?;
    let total_orders = player_total_orders + seed_buy_total_orders + seed_sell_total_orders;
    let open_orders = player_open_orders + seed_buy_open_orders + seed_sell_open_orders;
    let open_buy_orders = player_open_buy_orders + seed_buy_open_orders;
    let open_sell_orders = player_open_sell_orders + seed_sell_open_orders;
    tracker.emit(
        StartupStage::Counts,
        2.0 / total_steps,
        format!(
            "ord {} | open {} | buy {} | sell {}",
            format_count(total_orders),
            format_count(open_orders),
            format_count(open_buy_orders),
            format_count(open_sell_orders)
        ),
    );

    tracker.emit(StartupStage::Counts, 2.0 / total_steps, "events");
    let order_event_rows =
        connection.query_row("SELECT COUNT(*) FROM market_order_events", [], |row| {
            row.get::<_, u64>(0)
        })?;
    tracker.emit(
        StartupStage::Counts,
        1.0,
        format!("evt {}", format_count(order_event_rows)),
    );

    Ok(StartupCounts {
        price_history_rows,
        total_orders,
        open_orders,
        open_buy_orders,
        open_sell_orders,
        closed_orders: total_orders.saturating_sub(open_orders),
        order_event_rows,
    })
}

fn query_seed_buy_order_by_id_with_connection(
    connection: &Connection,
    station_id: u64,
    type_id: u32,
) -> Result<Option<OwnerOrderRow>> {
    connection
        .query_row(
            "SELECT price, quantity, initial_quantity, solar_system_id, constellation_id, region_id, updated_at
             FROM seed_buy_orders
             WHERE station_id = ?1 AND type_id = ?2",
            params![station_id, type_id],
            |row| {
                let vol_remaining = row.get::<_, u64>(1)?;
                let order_id = seed_buy_order_id(station_id, type_id);
                Ok(OwnerOrderRow {
                    order_id,
                    owner_id: 0,
                    is_corp: false,
                    state: if vol_remaining == 0 {
                        "filled".to_string()
                    } else {
                        "open".to_string()
                    },
                    source: "seed".to_string(),
                    last_state_change_at: None,
                    row: OrderRow {
                        order_id,
                        price: row.get(0)?,
                        vol_remaining,
                        type_id,
                        range_value: 32_767,
                        vol_entered: row.get::<_, u64>(2)?,
                        min_volume: 1,
                        bid: true,
                        issued_at: row.get(6)?,
                        duration_days: 3650,
                        station_id,
                        region_id: row.get(5)?,
                        solar_system_id: row.get(3)?,
                        constellation_id: row.get(4)?,
                        source: "seed".to_string(),
                    },
                })
            },
        )
        .optional()
        .map_err(Into::into)
}

fn format_count<T>(value: T) -> String
where
    T: ToString,
{
    let digits = value.to_string();
    let mut parts = Vec::new();
    let mut end = digits.len();

    while end > 3 {
        parts.push(digits[end - 3..end].to_string());
        end -= 3;
    }
    parts.push(digits[..end].to_string());
    parts.reverse();
    parts.join(",")
}

fn map_owner_order_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<OwnerOrderRow> {
    Ok(OwnerOrderRow {
        order_id: row.get(0)?,
        owner_id: row.get(1)?,
        is_corp: row.get::<_, i64>(2)? == 1,
        state: row.get(3)?,
        source: row.get(4)?,
        last_state_change_at: row.get(18)?,
        row: OrderRow {
            order_id: row.get(0)?,
            price: row.get(5)?,
            vol_remaining: row.get::<_, u64>(6)?,
            type_id: row.get(7)?,
            range_value: row.get(8)?,
            vol_entered: row.get::<_, u64>(9)?,
            min_volume: row.get::<_, u64>(10)?,
            bid: row.get::<_, i64>(11)? == 1,
            issued_at: row.get(12)?,
            duration_days: row.get(13)?,
            station_id: row.get(14)?,
            region_id: row.get(15)?,
            solar_system_id: row.get(16)?,
            constellation_id: row.get(17)?,
            source: row.get(4)?,
        },
    })
}

fn map_market_order_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<MarketOrderEvent> {
    Ok(MarketOrderEvent {
        event_id: row.get(0)?,
        event_type: row.get(1)?,
        occurred_at: row.get(2)?,
        order: OwnerOrderRow {
            order_id: row.get(3)?,
            owner_id: row.get(4)?,
            is_corp: row.get::<_, i64>(5)? == 1,
            state: row.get(6)?,
            source: row.get(7)?,
            last_state_change_at: row.get(21)?,
            row: OrderRow {
                order_id: row.get(3)?,
                price: row.get(8)?,
                vol_remaining: row.get::<_, u64>(9)?,
                type_id: row.get(10)?,
                range_value: row.get(11)?,
                vol_entered: row.get::<_, u64>(12)?,
                min_volume: row.get::<_, u64>(13)?,
                bid: row.get::<_, i64>(14)? == 1,
                issued_at: row.get(15)?,
                duration_days: row.get(16)?,
                station_id: row.get(17)?,
                region_id: row.get(18)?,
                solar_system_id: row.get(19)?,
                constellation_id: row.get(20)?,
                source: row.get(7)?,
            },
        },
    })
}

fn lookup_station_meta(connection: &Connection, station_id: u64) -> Result<StationMeta> {
    connection
        .query_row(
            "SELECT station_id, solar_system_id, constellation_id, region_id
             FROM stations
             WHERE station_id = ?1",
            params![station_id],
            |row| {
                Ok(StationMeta {
                    station_id: row.get(0)?,
                    solar_system_id: row.get(1)?,
                    constellation_id: row.get(2)?,
                    region_id: row.get(3)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| anyhow!("station {} does not exist in market database", station_id))
}

fn insert_order(database_path: &Path, request: PlaceOrderRequest) -> Result<PlaceOrderResponse> {
    if request.price <= 0.0 {
        bail!("price must be greater than zero");
    }
    if request.quantity == 0 {
        bail!("quantity must be greater than zero");
    }

    let mut connection = load_connection(database_path)?;
    let station_meta = lookup_station_meta(&connection, request.station_id)?;
    let now = now_rfc3339();
    let source = request.source.unwrap_or_else(|| "player".to_string());
    let wallet_division = request.wallet_division.unwrap_or(1000);
    let min_volume = request.min_volume.unwrap_or(1);
    let duration_days = request.duration_days.unwrap_or(90);
    let range_value = request.range_value.unwrap_or(32_767);
    let transaction = connection.transaction()?;
    transaction.execute(
        "INSERT INTO market_orders (
           owner_id, is_corp, wallet_division, station_id, solar_system_id, constellation_id, region_id,
           type_id, price, vol_entered, vol_remaining, min_volume, bid, range_value, duration_days,
           escrow, state, source, issued_at, last_state_change_at, updated_at
         ) VALUES (
           ?1, ?2, ?3, ?4, ?5, ?6, ?7,
           ?8, ?9, ?10, ?10, ?11, ?12, ?13, ?14,
           0, 'open', ?15, ?16, NULL, ?16
         )",
        params![
            request.owner_id,
            if request.is_corp { 1 } else { 0 },
            wallet_division,
            station_meta.station_id,
            station_meta.solar_system_id,
            station_meta.constellation_id,
            station_meta.region_id,
            request.type_id,
            request.price,
            request.quantity,
            min_volume,
            if request.bid { 1 } else { 0 },
            range_value,
            duration_days,
            source,
            now,
        ],
    )?;
    let order_id = transaction.last_insert_rowid();
    transaction.commit()?;

    Ok(PlaceOrderResponse {
        order_id,
        region_id: station_meta.region_id,
        solar_system_id: station_meta.solar_system_id,
        station_id: station_meta.station_id,
        type_id: request.type_id,
        cached_regions_invalidated: 1,
    })
}

fn modify_order_in_db(
    database_path: &Path,
    request: ModifyOrderRequest,
) -> Result<ModifyOrderResponse> {
    if request.new_price <= 0.0 {
        bail!("new_price must be greater than zero");
    }

    let mut connection = load_connection(database_path)?;
    let transaction = connection.transaction()?;
    let scope = transaction
        .query_row(
            "SELECT region_id, solar_system_id, station_id, type_id, bid, vol_remaining, state
             FROM market_orders
             WHERE order_id = ?1",
            params![request.order_id],
            |row| {
                Ok((
                    row.get::<_, u32>(0)?,
                    row.get::<_, u32>(1)?,
                    row.get::<_, u64>(2)?,
                    row.get::<_, u32>(3)?,
                    row.get::<_, i64>(4)? == 1,
                    row.get::<_, u64>(5)?,
                    row.get::<_, String>(6)?,
                ))
            },
        )
        .optional()?;

    let Some((region_id, solar_system_id, station_id, type_id, bid, vol_remaining, state)) = scope
    else {
        bail!("order {} not found", request.order_id);
    };

    if state != "open" {
        transaction.commit()?;
        return Ok(ModifyOrderResponse {
            order_id: request.order_id,
            region_id,
            solar_system_id,
            station_id,
            type_id,
            bid,
            price: request.new_price,
            vol_remaining,
            state,
            invalidated: false,
        });
    }

    let updated_at = now_rfc3339();
    transaction.execute(
        "UPDATE market_orders
         SET price = ?2, updated_at = ?3
         WHERE order_id = ?1",
        params![request.order_id, request.new_price, updated_at],
    )?;
    transaction.commit()?;

    Ok(ModifyOrderResponse {
        order_id: request.order_id,
        region_id,
        solar_system_id,
        station_id,
        type_id,
        bid,
        price: request.new_price,
        vol_remaining,
        state: "open".to_string(),
        invalidated: true,
    })
}

fn cancel_order_in_db(
    database_path: &Path,
    order_id: i64,
) -> Result<market_common::CancelOrderResponse> {
    let mut connection = load_connection(database_path)?;
    let transaction = connection.transaction()?;
    let scope = transaction
        .query_row(
            "SELECT state FROM market_orders WHERE order_id = ?1",
            params![order_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;

    let Some(state) = scope else {
        bail!("order {} not found", order_id);
    };

    if state != "open" {
        transaction.commit()?;
        return Ok(market_common::CancelOrderResponse {
            order_id,
            state,
            invalidated: false,
        });
    }

    let now = now_rfc3339();
    transaction.execute(
        "UPDATE market_orders
         SET state = 'cancelled', last_state_change_at = ?2, updated_at = ?2
         WHERE order_id = ?1",
        params![order_id, now],
    )?;
    transaction.commit()?;

    Ok(market_common::CancelOrderResponse {
        order_id,
        state: "cancelled".to_string(),
        invalidated: true,
    })
}

fn cancel_station_orders_in_db(
    database_path: &Path,
    station_id: u64,
) -> Result<Vec<OwnerOrderRow>> {
    let mut connection = load_connection(database_path)?;
    let transaction = connection.transaction()?;
    let mut cancelled_orders = Vec::new();
    {
        let mut statement = transaction.prepare(
            "SELECT order_id, owner_id, is_corp, state, source, price, vol_remaining, type_id,
                    range_value, vol_entered, min_volume, bid, issued_at, duration_days,
                    station_id, region_id, solar_system_id, constellation_id, last_state_change_at
             FROM market_orders
             WHERE station_id = ?1
               AND state = 'open'
               AND source = 'player'
             ORDER BY order_id ASC",
        )?;
        let rows = statement.query_map(params![station_id], map_owner_order_row)?;

        for row in rows {
            cancelled_orders.push(row?);
        }
    }

    if cancelled_orders.is_empty() {
        transaction.commit()?;
        return Ok(cancelled_orders);
    }

    let cancelled_at = now_rfc3339();
    for order in &cancelled_orders {
        transaction.execute(
            "UPDATE market_orders
             SET state = 'cancelled', last_state_change_at = ?2, updated_at = ?2
             WHERE order_id = ?1",
            params![order.order_id, cancelled_at],
        )?;
        transaction.execute(
            "INSERT INTO market_order_events (
               event_type, order_id, owner_id, is_corp, state, source, price, vol_remaining,
               type_id, range_value, vol_entered, min_volume, bid, issued_at, duration_days,
               station_id, region_id, solar_system_id, constellation_id, last_state_change_at,
               occurred_at
             ) VALUES (
               'cancelled', ?1, ?2, ?3, 'cancelled', ?4, ?5, ?6,
               ?7, ?8, ?9, ?10, ?11, ?12, ?13,
               ?14, ?15, ?16, ?17, ?18, ?18
             )",
            params![
                order.order_id,
                order.owner_id,
                if order.is_corp { 1 } else { 0 },
                order.source,
                order.row.price,
                order.row.vol_remaining,
                order.row.type_id,
                order.row.range_value,
                order.row.vol_entered,
                order.row.min_volume,
                if order.row.bid { 1 } else { 0 },
                order.row.issued_at,
                order.row.duration_days,
                order.row.station_id,
                order.row.region_id,
                order.row.solar_system_id,
                order.row.constellation_id,
                cancelled_at,
            ],
        )?;
    }

    transaction.commit()?;

    for order in &mut cancelled_orders {
        order.state = "cancelled".to_string();
        order.last_state_change_at = Some(cancelled_at.clone());
    }

    Ok(cancelled_orders)
}

fn fill_order_in_db(database_path: &Path, request: FillOrderRequest) -> Result<FillOrderResponse> {
    if request.fill_quantity == 0 {
        bail!("fill_quantity must be greater than zero");
    }

    let mut connection = load_connection(database_path)?;
    let transaction = connection.transaction()?;
    if let Some((station_id, type_id)) = try_decode_seed_buy_order_id(request.order_id) {
        let scope = transaction
            .query_row(
                "SELECT region_id, solar_system_id, price, quantity
                 FROM seed_buy_orders
                 WHERE station_id = ?1 AND type_id = ?2",
                params![station_id, type_id],
                |row| {
                    Ok((
                        row.get::<_, u32>(0)?,
                        row.get::<_, u32>(1)?,
                        row.get::<_, f64>(2)?,
                        row.get::<_, u64>(3)?,
                    ))
                },
            )
            .optional()?;

        let Some((region_id, solar_system_id, price, vol_remaining)) = scope else {
            bail!("order {} not found", request.order_id);
        };

        if request.fill_quantity > vol_remaining {
            bail!("fill quantity exceeds remaining order volume");
        }

        let next_remaining = vol_remaining - request.fill_quantity;
        transaction.execute(
            "UPDATE seed_buy_orders
             SET quantity = ?3, updated_at = ?4
             WHERE station_id = ?1 AND type_id = ?2",
            params![station_id, type_id, next_remaining, now_rfc3339()],
        )?;
        transaction.commit()?;

        return Ok(FillOrderResponse {
            order_id: request.order_id,
            owner_id: 0,
            is_corp: false,
            region_id,
            solar_system_id,
            station_id,
            type_id,
            bid: true,
            price,
            filled_quantity: request.fill_quantity,
            vol_remaining: next_remaining,
            state: if next_remaining == 0 {
                "filled".to_string()
            } else {
                "open".to_string()
            },
            invalidated: true,
        });
    }

    let scope = transaction
        .query_row(
            "SELECT owner_id, is_corp, region_id, solar_system_id, station_id, type_id, bid, price,
                    vol_remaining, state
             FROM market_orders
             WHERE order_id = ?1",
            params![request.order_id],
            |row| {
                Ok((
                    row.get::<_, u64>(0)?,
                    row.get::<_, i64>(1)? == 1,
                    row.get::<_, u32>(2)?,
                    row.get::<_, u32>(3)?,
                    row.get::<_, u64>(4)?,
                    row.get::<_, u32>(5)?,
                    row.get::<_, i64>(6)? == 1,
                    row.get::<_, f64>(7)?,
                    row.get::<_, u64>(8)?,
                    row.get::<_, String>(9)?,
                ))
            },
        )
        .optional()?;

    let Some((
        owner_id,
        is_corp,
        region_id,
        solar_system_id,
        station_id,
        type_id,
        bid,
        price,
        vol_remaining,
        state,
    )) = scope
    else {
        bail!("order {} not found", request.order_id);
    };

    if state != "open" {
        transaction.commit()?;
        return Ok(FillOrderResponse {
            order_id: request.order_id,
            owner_id,
            is_corp,
            region_id,
            solar_system_id,
            station_id,
            type_id,
            bid,
            price,
            filled_quantity: 0,
            vol_remaining,
            state,
            invalidated: false,
        });
    }

    if request.fill_quantity > vol_remaining {
        bail!("fill quantity exceeds remaining order volume");
    }

    let next_remaining = vol_remaining - request.fill_quantity;
    let next_state = if next_remaining == 0 {
        "filled"
    } else {
        "open"
    };
    let state_change_at = if next_state == "filled" {
        Some(now_rfc3339())
    } else {
        None
    };

    transaction.execute(
        "UPDATE market_orders
         SET vol_remaining = ?2,
             state = ?3,
             last_state_change_at = CASE WHEN ?5 IS NULL THEN last_state_change_at ELSE ?5 END,
             updated_at = ?4
         WHERE order_id = ?1",
        params![
            request.order_id,
            next_remaining,
            next_state,
            now_rfc3339(),
            state_change_at,
        ],
    )?;
    transaction.commit()?;

    Ok(FillOrderResponse {
        order_id: request.order_id,
        owner_id,
        is_corp,
        region_id,
        solar_system_id,
        station_id,
        type_id,
        bid,
        price,
        filled_quantity: request.fill_quantity,
        vol_remaining: next_remaining,
        state: next_state.to_string(),
        invalidated: true,
    })
}

fn expire_due_orders_in_db(database_path: &Path) -> Result<Vec<OwnerOrderRow>> {
    let mut connection = load_connection(database_path)?;
    let transaction = connection.transaction()?;
    let mut expired_orders = Vec::new();
    {
        let mut statement = transaction.prepare(
            "SELECT order_id, owner_id, is_corp, state, source, price, vol_remaining, type_id,
                    range_value, vol_entered, min_volume, bid, issued_at, duration_days,
                    station_id, region_id, solar_system_id, constellation_id, last_state_change_at
             FROM market_orders
             WHERE state = 'open'
               AND source = 'player'
               AND datetime(issued_at, '+' || duration_days || ' days') <= datetime('now')
             ORDER BY order_id ASC",
        )?;
        let rows = statement.query_map([], map_owner_order_row)?;

        for row in rows {
            expired_orders.push(row?);
        }
    }

    if expired_orders.is_empty() {
        transaction.commit()?;
        return Ok(expired_orders);
    }

    let swept_at = now_rfc3339();
    for order in &expired_orders {
        transaction.execute(
            "UPDATE market_orders
             SET state = 'expired', last_state_change_at = ?2, updated_at = ?2
             WHERE order_id = ?1",
            params![order.order_id, swept_at],
        )?;
        transaction.execute(
            "INSERT INTO market_order_events (
               event_type, order_id, owner_id, is_corp, state, source, price, vol_remaining,
               type_id, range_value, vol_entered, min_volume, bid, issued_at, duration_days,
               station_id, region_id, solar_system_id, constellation_id, last_state_change_at,
               occurred_at
             ) VALUES (
               'expired', ?1, ?2, ?3, 'expired', ?4, ?5, ?6,
               ?7, ?8, ?9, ?10, ?11, ?12, ?13,
               ?14, ?15, ?16, ?17, ?18, ?18
             )",
            params![
                order.order_id,
                order.owner_id,
                if order.is_corp { 1 } else { 0 },
                order.source,
                order.row.price,
                order.row.vol_remaining,
                order.row.type_id,
                order.row.range_value,
                order.row.vol_entered,
                order.row.min_volume,
                if order.row.bid { 1 } else { 0 },
                order.row.issued_at,
                order.row.duration_days,
                order.row.station_id,
                order.row.region_id,
                order.row.solar_system_id,
                order.row.constellation_id,
                swept_at,
            ],
        )?;
    }

    transaction.commit()?;

    for order in &mut expired_orders {
        order.state = "expired".to_string();
        order.last_state_change_at = Some(swept_at.clone());
    }

    Ok(expired_orders)
}

fn adjust_seed_stock_in_db(
    database_path: &Path,
    request: AdjustSeedStockRequest,
) -> Result<AdjustSeedStockResponse> {
    let mut connection = load_connection(database_path)?;
    let transaction = connection.transaction()?;
    let response = adjust_seed_stock_in_transaction(&transaction, &request)?;
    transaction.commit()?;
    Ok(response)
}

fn adjust_seed_stock_in_transaction(
    transaction: &Transaction<'_>,
    request: &AdjustSeedStockRequest,
) -> Result<AdjustSeedStockResponse> {
    if request.delta_quantity.is_some() && request.new_quantity.is_some() {
        bail!("seed stock adjustment cannot set both delta_quantity and new_quantity");
    }

    let adjustment_id = request
        .adjustment_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if let Some(adjustment_id) = adjustment_id {
        let existing_adjustment = transaction
            .query_row(
                "SELECT station_id, solar_system_id, region_id, type_id,
                        delta_quantity, quantity_after, price_after, reason
                 FROM seed_stock_adjustments
                 WHERE adjustment_id = ?1",
                params![adjustment_id],
                |row| {
                    Ok((
                        AdjustSeedStockResponse {
                            station_id: row.get::<_, u64>(0)?,
                            solar_system_id: row.get::<_, u32>(1)?,
                            region_id: row.get::<_, u32>(2)?,
                            type_id: row.get::<_, u32>(3)?,
                            quantity: row.get::<_, u64>(5)?,
                            price: row.get::<_, f64>(6)?,
                            applied: false,
                        },
                        row.get::<_, Option<i64>>(4)?,
                        row.get::<_, Option<String>>(7)?,
                    ))
                },
            )
            .optional()?;
        if let Some((response, recorded_delta, recorded_reason)) = existing_adjustment {
            if response.station_id != request.station_id || response.type_id != request.type_id {
                bail!("seed stock adjustment id was already used for a different station or type");
            }
            if let Some(new_quantity) = request.new_quantity {
                if response.quantity != new_quantity {
                    bail!("seed stock adjustment id was already used with a different quantity");
                }
            } else if recorded_delta != Some(request.delta_quantity.unwrap_or(0)) {
                bail!("seed stock adjustment id was already used with a different delta");
            }
            // Price is derived from the caller's stock view, not the identity
            // of the quantity mutation. If the daemon commits an adjustment
            // but the caller restarts before persisting the response, its
            // refreshed (post-adjustment) stock view can legitimately produce
            // a different retry price. The adjustment token plus the strict
            // station/type/quantity/reason fingerprint above and below still
            // protect against token reuse; return the original receipt and
            // original price for an idempotent replay.
            if recorded_reason.as_deref() != request.reason.as_deref() {
                bail!("seed stock adjustment id was already used with a different reason");
            }
            return Ok(response);
        }
    }

    let current = transaction
        .query_row(
            "SELECT station_id, solar_system_id, constellation_id, region_id, quantity, price
             FROM seed_stock
             WHERE station_id = ?1 AND type_id = ?2",
            params![request.station_id, request.type_id],
            |row| {
                Ok((
                    row.get::<_, u64>(0)?,
                    row.get::<_, u32>(1)?,
                    row.get::<_, u32>(2)?,
                    row.get::<_, u32>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, f64>(5)?,
                    true,
                ))
            },
        )
        .optional()?;

    let (
        station_id,
        solar_system_id,
        constellation_id,
        region_id,
        current_quantity,
        current_price,
        row_exists,
    ) = if let Some(current) = current {
        current
    } else {
        if !request.allow_create {
            bail!(
                "seed stock not found for station {} type {}",
                request.station_id,
                request.type_id
            );
        }
        let station = transaction
            .query_row(
                "SELECT station_id, solar_system_id, constellation_id, region_id
                 FROM stations WHERE station_id = ?1",
                params![request.station_id],
                |row| {
                    Ok((
                        row.get::<_, u64>(0)?,
                        row.get::<_, u32>(1)?,
                        row.get::<_, u32>(2)?,
                        row.get::<_, u32>(3)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| anyhow!("station {} not found", request.station_id))?;
        let fallback_price = transaction
            .query_row(
                "SELECT base_price FROM market_types WHERE type_id = ?1",
                params![request.type_id],
                |row| row.get::<_, Option<f64>>(0),
            )
            .optional()?
            .flatten()
            .unwrap_or(100.0)
            .max(0.01);
        (
            station.0,
            station.1,
            station.2,
            station.3,
            0,
            fallback_price,
            false,
        )
    };

    if row_exists && request.create_only {
        return Ok(AdjustSeedStockResponse {
            station_id,
            type_id: request.type_id,
            region_id,
            solar_system_id,
            quantity: u64::try_from(current_quantity).unwrap_or(0),
            price: current_price,
            applied: false,
        });
    }

    let target_quantity = if let Some(new_quantity) = request.new_quantity {
        i64::try_from(new_quantity)
            .map_err(|_| anyhow!("seed stock quantity exceeds the supported maximum"))?
    } else {
        current_quantity
            .checked_add(request.delta_quantity.unwrap_or(0))
            .ok_or_else(|| anyhow!("seed stock quantity adjustment overflowed"))?
    };
    if target_quantity < 0 {
        bail!("seed stock quantity cannot become negative");
    }

    let target_price = request.new_price.unwrap_or(current_price);
    if !target_price.is_finite() || target_price <= 0.0 {
        bail!("seed stock price must be a positive finite number");
    }
    let applied_at = now_rfc3339();
    if row_exists {
        transaction.execute(
            "UPDATE seed_stock
             SET quantity = ?3,
                 initial_quantity = MAX(initial_quantity, ?3),
                 price = ?4,
                 updated_at = ?5,
                 price_version = price_version + CASE WHEN price <> ?4 THEN 1 ELSE 0 END
             WHERE station_id = ?1 AND type_id = ?2",
            params![
                station_id,
                request.type_id,
                target_quantity,
                target_price,
                applied_at,
            ],
        )?;
    } else if request.create_only {
        let inserted = transaction.execute(
            "INSERT INTO seed_stock (
               station_id, solar_system_id, constellation_id, region_id, type_id,
               price, quantity, initial_quantity, price_version, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, 1, ?8)
             ON CONFLICT(station_id, type_id) DO NOTHING",
            params![
                station_id,
                solar_system_id,
                constellation_id,
                region_id,
                request.type_id,
                target_price,
                target_quantity,
                applied_at,
            ],
        )?;
        if inserted == 0 {
            let existing = transaction.query_row(
                "SELECT station_id, solar_system_id, region_id, type_id, quantity, price
                 FROM seed_stock WHERE station_id = ?1 AND type_id = ?2",
                params![request.station_id, request.type_id],
                |row| {
                    Ok(AdjustSeedStockResponse {
                        station_id: row.get::<_, u64>(0)?,
                        solar_system_id: row.get::<_, u32>(1)?,
                        region_id: row.get::<_, u32>(2)?,
                        type_id: row.get::<_, u32>(3)?,
                        quantity: row.get::<_, u64>(4)?,
                        price: row.get::<_, f64>(5)?,
                        applied: false,
                    })
                },
            )?;
            return Ok(existing);
        }
    } else {
        transaction.execute(
            "INSERT INTO seed_stock (
               station_id, solar_system_id, constellation_id, region_id, type_id,
               price, quantity, initial_quantity, price_version, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, 1, ?8)",
            params![
                station_id,
                solar_system_id,
                constellation_id,
                region_id,
                request.type_id,
                target_price,
                target_quantity,
                applied_at,
            ],
        )?;
    }

    if let Some(adjustment_id) = adjustment_id {
        transaction.execute(
            "INSERT INTO seed_stock_adjustments (
               adjustment_id, station_id, solar_system_id, region_id, type_id,
               delta_quantity, quantity_after, price_after, reason, applied_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                adjustment_id,
                station_id,
                solar_system_id,
                region_id,
                request.type_id,
                target_quantity - current_quantity,
                target_quantity,
                target_price,
                request.reason.as_deref(),
                applied_at,
            ],
        )?;
    }
    Ok(AdjustSeedStockResponse {
        station_id,
        type_id: request.type_id,
        region_id,
        solar_system_id,
        quantity: u64::try_from(target_quantity).unwrap_or(0),
        price: target_price,
        applied: true,
    })
}

fn adjust_seed_stocks_in_db(
    database_path: &Path,
    request: AdjustSeedStocksRequest,
) -> Result<Vec<AdjustSeedStockResponse>> {
    if request.adjustments.len() > 512 {
        bail!("adjust seed stocks request exceeds 512 adjustments");
    }
    let mut connection = load_connection(database_path)?;
    let transaction = connection.transaction()?;
    let mut responses = Vec::with_capacity(request.adjustments.len());
    for adjustment in &request.adjustments {
        responses.push(adjust_seed_stock_in_transaction(&transaction, adjustment)?);
    }

    let region_summary_keys = responses
        .iter()
        .filter(|row| row.applied)
        .map(|row| (row.region_id, row.type_id))
        .collect::<HashSet<_>>();
    for (region_id, type_id) in region_summary_keys {
        transaction.execute(
            "DELETE FROM region_summaries WHERE region_id = ?1 AND type_id = ?2",
            params![region_id, type_id],
        )?;
        if let Some(row) = compute_single_summary_row_for_region(&transaction, region_id, type_id)?
        {
            insert_region_summary_row(&transaction, region_id, &row)?;
        }
    }

    let system_summary_keys = responses
        .iter()
        .filter(|row| row.applied)
        .map(|row| (row.solar_system_id, row.type_id))
        .collect::<HashSet<_>>();
    for (solar_system_id, type_id) in system_summary_keys {
        transaction.execute(
            "DELETE FROM system_seed_summaries WHERE solar_system_id = ?1 AND type_id = ?2",
            params![solar_system_id, type_id],
        )?;
        if let Some(row) =
            compute_single_system_seed_summary_row(&transaction, solar_system_id, type_id)?
        {
            insert_system_seed_summary_row(&transaction, solar_system_id, &row)?;
        }
    }
    transaction.commit()?;
    Ok(responses)
}

fn read_seed_stocks_in_db(
    database_path: &Path,
    request: GetSeedStocksRequest,
) -> Result<Vec<SeedStockRow>> {
    if request.keys.len() > 10_000 {
        bail!("get seed stocks request exceeds 10000 keys");
    }
    let connection = load_connection(database_path)?;
    let mut statement = connection.prepare(
        "SELECT station_id, solar_system_id, constellation_id, region_id, type_id,
                quantity, initial_quantity, price, price_version, updated_at
         FROM seed_stock
         WHERE station_id = ?1 AND type_id = ?2",
    )?;
    let mut seen = HashSet::new();
    let mut rows = Vec::new();
    for key in request.keys {
        if !seen.insert((key.station_id, key.type_id)) {
            continue;
        }
        let row = statement
            .query_row(params![key.station_id, key.type_id], |row| {
                Ok(SeedStockRow {
                    station_id: row.get::<_, u64>(0)?,
                    solar_system_id: row.get::<_, u32>(1)?,
                    constellation_id: row.get::<_, u32>(2)?,
                    region_id: row.get::<_, u32>(3)?,
                    type_id: row.get::<_, u32>(4)?,
                    quantity: row.get::<_, u64>(5)?,
                    initial_quantity: row.get::<_, u64>(6)?,
                    price: row.get::<_, f64>(7)?,
                    price_version: row.get::<_, u64>(8)?,
                    updated_at: row.get::<_, String>(9)?,
                })
            })
            .optional()?;
        if let Some(row) = row {
            rows.push(row);
        }
    }
    Ok(rows)
}

fn record_trade_in_db(
    database_path: &Path,
    request: RecordTradeRequest,
) -> Result<RecordTradeResponse> {
    let mut connection = load_connection(database_path)?;
    let transaction = connection.transaction()?;
    let day = current_trade_day();

    let existing = transaction
        .query_row(
            "SELECT low_price, high_price, avg_price, volume, order_count
             FROM price_history
             WHERE type_id = ?1 AND day = ?2",
            params![request.type_id, day],
            |row| {
                Ok((
                    row.get::<_, f64>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, f64>(2)?,
                    row.get::<_, u64>(3)?,
                    row.get::<_, u32>(4)?,
                ))
            },
        )
        .optional()?;

    match existing {
        Some((low_price, high_price, avg_price, volume, order_count)) => {
            let next_volume = volume + request.quantity;
            let weighted_total =
                avg_price * volume as f64 + request.price * request.quantity as f64;
            let next_avg = if next_volume == 0 {
                request.price
            } else {
                weighted_total / next_volume as f64
            };
            transaction.execute(
                "UPDATE price_history
                 SET low_price = ?3,
                     high_price = ?4,
                     avg_price = ?5,
                     volume = ?6,
                     order_count = ?7
                 WHERE type_id = ?1 AND day = ?2",
                params![
                    request.type_id,
                    day,
                    low_price.min(request.price),
                    high_price.max(request.price),
                    next_avg,
                    next_volume,
                    order_count + 1,
                ],
            )?;
        }
        None => {
            transaction.execute(
                "INSERT INTO price_history (
                   type_id, day, low_price, high_price, avg_price, volume, order_count
                 ) VALUES (?1, ?2, ?3, ?3, ?3, ?4, 1)",
                params![request.type_id, day, request.price, request.quantity],
            )?;
        }
    }

    transaction.commit()?;

    Ok(RecordTradeResponse {
        type_id: request.type_id,
        day,
        price: request.price,
        quantity: request.quantity,
    })
}

fn rebuild_region_summary_cache(
    database_path: &Path,
    region_id: Option<u32>,
) -> Result<CacheRebuildResponse> {
    let mut connection = load_connection(database_path)?;
    let transaction = connection.transaction()?;
    let rebuilt_rows = match region_id {
        Some(region_id) => rebuild_single_region_summary(&transaction, region_id)?,
        None => {
            let region_ids = {
                let mut statement = transaction.prepare(
                    "SELECT DISTINCT region_id
                     FROM stations
                     ORDER BY region_id ASC",
                )?;
                let rows = statement.query_map([], |row| row.get::<_, u32>(0))?;
                let mut ids = Vec::new();
                for row in rows {
                    ids.push(row?);
                }
                ids
            };

            let mut total = 0usize;
            for region_id in region_ids {
                total += rebuild_single_region_summary(&transaction, region_id)?;
            }
            total
        }
    };
    transaction.commit()?;

    Ok(CacheRebuildResponse {
        region_id,
        rebuilt_rows,
        rebuilt_at: now_rfc3339(),
    })
}

fn rebuild_single_region_summary(connection: &Connection, region_id: u32) -> Result<usize> {
    connection.execute(
        "DELETE FROM region_summaries WHERE region_id = ?1",
        params![region_id],
    )?;

    let rows = compute_summary_rows_for_region(connection, region_id)?;
    let rebuilt_rows = rows.len();
    for row in rows {
        insert_region_summary_row(connection, region_id, &row)?;
    }

    Ok(rebuilt_rows)
}

fn refresh_single_region_summary_row(
    database_path: &Path,
    region_id: u32,
    type_id: u32,
) -> Result<()> {
    let mut connection = load_connection(database_path)?;
    let transaction = connection.transaction()?;
    transaction.execute(
        "DELETE FROM region_summaries WHERE region_id = ?1 AND type_id = ?2",
        params![region_id, type_id],
    )?;

    if let Some(row) = compute_single_summary_row_for_region(&transaction, region_id, type_id)? {
        insert_region_summary_row(&transaction, region_id, &row)?;
    }

    transaction.commit()?;
    Ok(())
}

fn refresh_single_system_seed_summary_row(
    database_path: &Path,
    solar_system_id: u32,
    type_id: u32,
) -> Result<()> {
    let mut connection = load_connection(database_path)?;
    let transaction = connection.transaction()?;
    transaction.execute(
        "DELETE FROM system_seed_summaries WHERE solar_system_id = ?1 AND type_id = ?2",
        params![solar_system_id, type_id],
    )?;

    if let Some(row) =
        compute_single_system_seed_summary_row(&transaction, solar_system_id, type_id)?
    {
        insert_system_seed_summary_row(&transaction, solar_system_id, &row)?;
    }

    transaction.commit()?;
    Ok(())
}

fn compute_summary_rows_for_region(
    connection: &Connection,
    region_id: u32,
) -> Result<Vec<SummaryRow>> {
    query_summary_rows_for_scope(connection, "region_id", i64::from(region_id))
}

fn compute_single_system_seed_summary_row(
    connection: &Connection,
    solar_system_id: u32,
    type_id: u32,
) -> Result<Option<SummaryRow>> {
    let sells = connection
        .query_row(
            "WITH sell_totals AS (
               SELECT type_id, MIN(price) AS best_ask_price, SUM(quantity) AS total_ask_quantity
               FROM seed_stock
               WHERE solar_system_id = ?1 AND type_id = ?2 AND quantity > 0
               GROUP BY type_id
             )
             SELECT sell_totals.type_id,
                    sell_totals.best_ask_price,
                    sell_totals.total_ask_quantity,
                    MIN(seed_stock.station_id) AS best_ask_station_id
             FROM sell_totals
             JOIN seed_stock
               ON seed_stock.solar_system_id = ?1
              AND seed_stock.type_id = sell_totals.type_id
              AND seed_stock.price = sell_totals.best_ask_price
              AND seed_stock.quantity > 0
             GROUP BY sell_totals.type_id, sell_totals.best_ask_price, sell_totals.total_ask_quantity",
            params![solar_system_id, type_id],
            |row| {
                Ok((
                    row.get::<_, u32>(0)?,
                    row.get::<_, Option<f64>>(1)?,
                    row.get::<_, u64>(2)?,
                    row.get::<_, Option<u64>>(3)?,
                ))
            },
        )
        .optional()?;

    let buys = connection
        .query_row(
            "WITH buy_totals AS (
               SELECT type_id, MAX(price) AS best_bid_price, SUM(quantity) AS total_bid_quantity
               FROM seed_buy_orders
               WHERE solar_system_id = ?1 AND type_id = ?2 AND quantity > 0
               GROUP BY type_id
             )
             SELECT buy_totals.type_id,
                    buy_totals.best_bid_price,
                    buy_totals.total_bid_quantity,
                    MIN(seed_buy_orders.station_id) AS best_bid_station_id
             FROM buy_totals
             JOIN seed_buy_orders
               ON seed_buy_orders.solar_system_id = ?1
              AND seed_buy_orders.type_id = buy_totals.type_id
              AND seed_buy_orders.price = buy_totals.best_bid_price
              AND seed_buy_orders.quantity > 0
             GROUP BY buy_totals.type_id, buy_totals.best_bid_price, buy_totals.total_bid_quantity",
            params![solar_system_id, type_id],
            |row| {
                Ok((
                    row.get::<_, u32>(0)?,
                    row.get::<_, Option<f64>>(1)?,
                    row.get::<_, u64>(2)?,
                    row.get::<_, Option<u64>>(3)?,
                ))
            },
        )
        .optional()?;

    match (sells, buys) {
        (None, None) => Ok(None),
        (Some((sell_type_id, best_ask_price, total_ask_quantity, best_ask_station_id)), None) => {
            Ok(Some(SummaryRow {
                type_id: sell_type_id,
                best_ask_price,
                total_ask_quantity,
                best_ask_station_id,
                best_bid_price: None,
                total_bid_quantity: 0,
                best_bid_station_id: None,
            }))
        }
        (None, Some((buy_type_id, best_bid_price, total_bid_quantity, best_bid_station_id))) => {
            Ok(Some(SummaryRow {
                type_id: buy_type_id,
                best_ask_price: None,
                total_ask_quantity: 0,
                best_ask_station_id: None,
                best_bid_price,
                total_bid_quantity,
                best_bid_station_id,
            }))
        }
        (
            Some((sell_type_id, best_ask_price, total_ask_quantity, best_ask_station_id)),
            Some((_, best_bid_price, total_bid_quantity, best_bid_station_id)),
        ) => Ok(Some(SummaryRow {
            type_id: sell_type_id,
            best_ask_price,
            total_ask_quantity,
            best_ask_station_id,
            best_bid_price,
            total_bid_quantity,
            best_bid_station_id,
        })),
    }
}

fn compute_single_summary_row_for_region(
    connection: &Connection,
    region_id: u32,
    type_id: u32,
) -> Result<Option<SummaryRow>> {
    let sells = connection
        .query_row(
            "WITH sells AS (
               SELECT type_id, price, quantity AS quantity_value, station_id
               FROM seed_stock
               WHERE region_id = ?1 AND type_id = ?2 AND quantity > 0
               UNION ALL
               SELECT type_id, price, vol_remaining AS quantity_value, station_id
               FROM market_orders
               WHERE region_id = ?1 AND type_id = ?2 AND state = 'open' AND bid = 0 AND vol_remaining > 0
             ),
             sell_totals AS (
               SELECT type_id, MIN(price) AS best_ask_price, SUM(quantity_value) AS total_ask_quantity
               FROM sells
               GROUP BY type_id
             )
             SELECT sell_totals.type_id,
                    sell_totals.best_ask_price,
                    sell_totals.total_ask_quantity,
                    MIN(sells.station_id) AS best_ask_station_id
             FROM sell_totals
             JOIN sells
               ON sells.type_id = sell_totals.type_id
              AND sells.price = sell_totals.best_ask_price
             GROUP BY sell_totals.type_id, sell_totals.best_ask_price, sell_totals.total_ask_quantity",
            params![region_id, type_id],
            |row| {
                Ok((
                    row.get::<_, u32>(0)?,
                    row.get::<_, Option<f64>>(1)?,
                    row.get::<_, u64>(2)?,
                    row.get::<_, Option<u64>>(3)?,
                ))
            },
        )
        .optional()?;

    let buys = connection
        .query_row(
            "WITH buys AS (
               SELECT type_id, price, quantity AS quantity_value, station_id
               FROM seed_buy_orders
               WHERE region_id = ?1 AND type_id = ?2 AND quantity > 0
               UNION ALL
               SELECT type_id, price, vol_remaining AS quantity_value, station_id
               FROM market_orders
               WHERE region_id = ?1 AND type_id = ?2 AND state = 'open' AND bid = 1 AND source = 'player' AND vol_remaining > 0
             ),
             buy_totals AS (
               SELECT type_id, MAX(price) AS best_bid_price, SUM(quantity_value) AS total_bid_quantity
               FROM buys
               GROUP BY type_id
             )
             SELECT buy_totals.type_id,
                    buy_totals.best_bid_price,
                    buy_totals.total_bid_quantity,
                    MIN(buys.station_id) AS best_bid_station_id
             FROM buy_totals
             JOIN buys
               ON buys.type_id = buy_totals.type_id
              AND buys.price = buy_totals.best_bid_price
             GROUP BY buy_totals.type_id, buy_totals.best_bid_price, buy_totals.total_bid_quantity",
            params![region_id, type_id],
            |row| {
                Ok((
                    row.get::<_, u32>(0)?,
                    row.get::<_, Option<f64>>(1)?,
                    row.get::<_, u64>(2)?,
                    row.get::<_, Option<u64>>(3)?,
                ))
            },
        )
        .optional()?;

    match (sells, buys) {
        (None, None) => Ok(None),
        (Some((sell_type_id, best_ask_price, total_ask_quantity, best_ask_station_id)), None) => {
            Ok(Some(SummaryRow {
                type_id: sell_type_id,
                best_ask_price,
                total_ask_quantity,
                best_ask_station_id,
                best_bid_price: None,
                total_bid_quantity: 0,
                best_bid_station_id: None,
            }))
        }
        (None, Some((buy_type_id, best_bid_price, total_bid_quantity, best_bid_station_id))) => {
            Ok(Some(SummaryRow {
                type_id: buy_type_id,
                best_ask_price: None,
                total_ask_quantity: 0,
                best_ask_station_id: None,
                best_bid_price,
                total_bid_quantity,
                best_bid_station_id,
            }))
        }
        (
            Some((sell_type_id, best_ask_price, total_ask_quantity, best_ask_station_id)),
            Some((_, best_bid_price, total_bid_quantity, best_bid_station_id)),
        ) => Ok(Some(SummaryRow {
            type_id: sell_type_id,
            best_ask_price,
            total_ask_quantity,
            best_ask_station_id,
            best_bid_price,
            total_bid_quantity,
            best_bid_station_id,
        })),
    }
}

fn insert_region_summary_row(
    connection: &Connection,
    region_id: u32,
    row: &SummaryRow,
) -> Result<()> {
    connection.execute(
        "INSERT INTO region_summaries (
           region_id, type_id, best_ask_price, total_ask_quantity, best_ask_station_id,
           best_bid_price, total_bid_quantity, best_bid_station_id, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            region_id,
            row.type_id,
            row.best_ask_price,
            row.total_ask_quantity,
            row.best_ask_station_id,
            row.best_bid_price,
            row.total_bid_quantity,
            row.best_bid_station_id,
            now_rfc3339(),
        ],
    )?;
    Ok(())
}

fn insert_system_seed_summary_row(
    connection: &Connection,
    solar_system_id: u32,
    row: &SummaryRow,
) -> Result<()> {
    connection.execute(
        "INSERT INTO system_seed_summaries (
           solar_system_id, type_id, best_ask_price, total_ask_quantity, best_ask_station_id,
           best_bid_price, total_bid_quantity, best_bid_station_id, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            solar_system_id,
            row.type_id,
            row.best_ask_price,
            row.total_ask_quantity,
            row.best_ask_station_id,
            row.best_bid_price,
            row.total_bid_quantity,
            row.best_bid_station_id,
            now_rfc3339(),
        ],
    )?;
    Ok(())
}

fn current_trade_day() -> String {
    OffsetDateTime::now_utc().date().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn replay_test_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("open replay test database");
        connection
            .execute_batch(SCHEMA_SQL)
            .expect("create market schema");
        connection
            .execute(
                "INSERT INTO stations (
                   station_id, solar_system_id, constellation_id, region_id,
                   station_name, security
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    60_000_001_u64,
                    30_000_001_u32,
                    20_000_001_u32,
                    10_000_001_u32,
                    "Replay Test",
                    0.9
                ],
            )
            .expect("insert test station");
        connection
            .execute(
                "INSERT INTO market_types (
                   type_id, group_id, category_id, market_group_id, name,
                   group_name, base_price, volume, portion_size, published
                 ) VALUES (?1, 1, 1, 1, ?2, ?3, ?4, 1.0, 1, 1)",
                params![34_u32, "Tritanium", "Mineral", 5.0_f64],
            )
            .expect("insert test type");
        connection
            .execute(
                "INSERT INTO seed_stock (
                   station_id, solar_system_id, constellation_id, region_id,
                   type_id, price, quantity, initial_quantity, price_version,
                   updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, 1, ?8)",
                params![
                    60_000_001_u64,
                    30_000_001_u32,
                    20_000_001_u32,
                    10_000_001_u32,
                    34_u32,
                    5.25_f64,
                    100_i64,
                    now_rfc3339(),
                ],
            )
            .expect("insert test stock");
        connection
    }

    fn apply_adjustment(
        connection: &mut Connection,
        request: &AdjustSeedStockRequest,
    ) -> Result<AdjustSeedStockResponse> {
        let transaction = connection.transaction()?;
        let response = adjust_seed_stock_in_transaction(&transaction, request)?;
        transaction.commit()?;
        Ok(response)
    }

    fn replay_test_request() -> AdjustSeedStockRequest {
        AdjustSeedStockRequest {
            station_id: 60_000_001,
            type_id: 34,
            delta_quantity: Some(25),
            new_quantity: None,
            new_price: Some(5.50),
            reason: Some("restart replay test".to_string()),
            adjustment_id: Some("restart-replay-0001".to_string()),
            allow_create: true,
            create_only: false,
        }
    }

    #[test]
    fn committed_adjustment_replays_after_restart_with_recomputed_price() {
        let mut connection = replay_test_connection();
        let first = apply_adjustment(&mut connection, &replay_test_request())
            .expect("first adjustment succeeds");
        assert!(first.applied);
        assert_eq!(first.quantity, 125);
        assert_eq!(first.price, 5.50);

        // Simulate losing the response/state write, restarting, refreshing the
        // already-adjusted row, and recomputing a different dynamic price.
        let mut replay = replay_test_request();
        replay.new_price = Some(5.10);
        let receipt =
            apply_adjustment(&mut connection, &replay).expect("replay returns original receipt");
        assert!(!receipt.applied);
        assert_eq!(receipt.quantity, 125);
        assert_eq!(receipt.price, 5.50);

        let persisted = connection
            .query_row(
                "SELECT quantity, price FROM seed_stock
                 WHERE station_id = ?1 AND type_id = ?2",
                params![replay.station_id, replay.type_id],
                |row| Ok((row.get::<_, u64>(0)?, row.get::<_, f64>(1)?)),
            )
            .expect("read persisted stock");
        assert_eq!(persisted, (125, 5.50));
    }

    #[test]
    fn replay_still_rejects_identity_and_quantity_collisions() {
        let mut connection = replay_test_connection();
        apply_adjustment(&mut connection, &replay_test_request())
            .expect("first adjustment succeeds");

        let mut wrong_station = replay_test_request();
        wrong_station.station_id += 1;
        let station_error = apply_adjustment(&mut connection, &wrong_station)
            .expect_err("station collision must fail");
        assert!(
            station_error
                .to_string()
                .contains("different station or type")
        );

        let mut wrong_type = replay_test_request();
        wrong_type.type_id += 1;
        let type_error =
            apply_adjustment(&mut connection, &wrong_type).expect_err("type collision must fail");
        assert!(type_error.to_string().contains("different station or type"));

        let mut wrong_delta = replay_test_request();
        wrong_delta.delta_quantity = Some(26);
        let delta_error = apply_adjustment(&mut connection, &wrong_delta)
            .expect_err("quantity collision must fail");
        assert!(delta_error.to_string().contains("different delta"));
    }

    #[test]
    fn omitted_create_only_flag_remains_a_normal_adjustment() {
        let request: AdjustSeedStockRequest = serde_json::from_value(serde_json::json!({
            "station_id": 60_000_001,
            "type_id": 34,
            "delta_quantity": 1,
            "new_quantity": null,
            "new_price": 5.25,
            "reason": "backward compatibility",
            "adjustment_id": "backward-compatible-adjustment",
            "allow_create": false
        }))
        .expect("deserialize legacy adjustment request");
        assert!(!request.create_only);
    }

    #[test]
    fn create_only_initialization_inserts_missing_stock_and_preserves_existing_rows() {
        let mut connection = replay_test_connection();
        connection
            .execute(
                "DELETE FROM seed_stock WHERE station_id = ?1 AND type_id = ?2",
                params![60_000_001_u64, 34_u32],
            )
            .expect("remove initial test stock");

        let initialize = AdjustSeedStockRequest {
            station_id: 60_000_001,
            type_id: 34,
            delta_quantity: None,
            new_quantity: Some(80),
            new_price: Some(5.25),
            reason: Some("automatic regional stock v1".to_string()),
            adjustment_id: Some("automatic-regional-stock-v1:60000001:34".to_string()),
            allow_create: true,
            create_only: true,
        };
        let inserted = apply_adjustment(&mut connection, &initialize)
            .expect("missing create-only stock is inserted");
        assert!(inserted.applied);
        assert_eq!(inserted.quantity, 80);

        let preserve = AdjustSeedStockRequest {
            new_quantity: Some(9_999),
            adjustment_id: Some("automatic-regional-stock-v1:60000001:34:retry".to_string()),
            ..initialize.clone()
        };
        let existing = apply_adjustment(&mut connection, &preserve)
            .expect("existing create-only stock is preserved");
        assert!(!existing.applied);
        assert_eq!(existing.quantity, 80);
        assert_eq!(existing.price, 5.25);

        connection
            .execute(
                "UPDATE seed_stock SET quantity = 0 WHERE station_id = ?1 AND type_id = ?2",
                params![60_000_001_u64, 34_u32],
            )
            .expect("deplete existing test stock");
        let preserve_depleted = AdjustSeedStockRequest {
            adjustment_id: Some("automatic-regional-stock-v1:60000001:34:depleted".to_string()),
            ..preserve
        };
        let depleted = apply_adjustment(&mut connection, &preserve_depleted)
            .expect("depleted create-only stock is not refilled");
        assert!(!depleted.applied);
        assert_eq!(depleted.quantity, 0);
    }
}
