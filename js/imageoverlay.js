// 画像図面のオーバーレイ (3点アフィン: 左上/右上/左下のハンドルをドラッグして位置合わせ)
(function (root) {
  root.MD = root.MD || {};
  var L = root.L;

  var AffineImage = L.Layer.extend({
    options: { opacity: 0.6 },
    initialize: function (url, corners, options) {
      // corners: [tl, tr, bl] L.LatLng
      this._url = url; this._corners = corners.map(L.latLng); L.setOptions(this, options);
    },
    onAdd: function (map) {
      var img = this._img = L.DomUtil.create('img', 'md-affine-img leaflet-zoom-animated');
      img.src = this._url; img.style.opacity = this.options.opacity;
      img.style.transformOrigin = '0 0'; img.style.position = 'absolute'; img.style.left = '0'; img.style.top = '0';
      img.style.pointerEvents = 'none'; img.style.maxWidth = 'none';
      var self = this;
      img.onload = function () { self._w = img.naturalWidth; self._h = img.naturalHeight; self._reset(); };
      this.getPane().appendChild(img);
      this._handles = this._corners.map(function (ll, i) {
        var m = L.marker(ll, { draggable: true, icon: L.divIcon({ className: 'md-handle md-handle-' + i, iconSize: [14, 14] }), zIndexOffset: 1000 });
        m.on('drag', function () { self._corners[i] = m.getLatLng(); self._reset(); });
        m.on('dragend', function () { self.fire('change'); });
        return m;
      });
      this._mover = L.marker(this._center(), { draggable: true, icon: L.divIcon({ className: 'md-handle md-handle-move', iconSize: [18, 18], html: '✥' }) });
      this._mover.on('dragstart', function () { self._dragStart = self._mover.getLatLng(); self._startCorners = self._corners.slice(); });
      this._mover.on('drag', function () {
        var p = self._mover.getLatLng(), dlat = p.lat - self._dragStart.lat, dlng = p.lng - self._dragStart.lng;
        self._corners = self._startCorners.map(function (c) { return L.latLng(c.lat + dlat, c.lng + dlng); });
        self._handles.forEach(function (h, i) { h.setLatLng(self._corners[i]); });
        self._reset(true);
      });
      this._mover.on('dragend', function () { self.fire('change'); });
      this.setEditable(this.options.editable !== false);
      map.on('zoomanim', this._animateZoom, this);
      map.on('zoomend viewreset', this._reset, this);
      this._reset();
    },
    onRemove: function (map) {
      L.DomUtil.remove(this._img);
      this._handles.forEach(function (h) { h.remove(); }); this._mover.remove();
      map.off('zoomanim', this._animateZoom, this); map.off('zoomend viewreset', this._reset, this);
    },
    setEditable: function (on) {
      this._editable = on; var map = this._map; if (!map) return;
      var all = this._handles.concat([this._mover]);
      all.forEach(function (h) { if (on) h.addTo(map); else h.remove(); });
    },
    setOpacity: function (o) { this.options.opacity = o; if (this._img) this._img.style.opacity = o; },
    getCorners: function () { return this._corners.slice(); },
    _center: function () { var c = this._corners; return L.latLng((c[1].lat + c[2].lat) / 2, (c[1].lng + c[2].lng) / 2); },
    _matrix: function (pts) {
      var w = this._w || 1, h = this._h || 1, p0 = pts[0], p1 = pts[1], p2 = pts[2];
      return 'matrix(' + [(p1.x - p0.x) / w, (p1.y - p0.y) / w, (p2.x - p0.x) / h, (p2.y - p0.y) / h, p0.x, p0.y].join(',') + ')';
    },
    _reset: function (skipMover) {
      if (!this._map || !this._img) return;
      var map = this._map;
      this._img.style.transform = this._matrix(this._corners.map(function (c) { return map.latLngToLayerPoint(c); }));
      if (!skipMover && this._mover) this._mover.setLatLng(this._center());
    },
    _animateZoom: function (e) {
      var map = this._map;
      this._img.style.transform = this._matrix(this._corners.map(function (c) { return map._latLngToNewLayerPoint(c, e.zoom, e.center); }));
    }
  });

  root.MD.AffineImage = AffineImage;
})(typeof window !== 'undefined' ? window : globalThis);
