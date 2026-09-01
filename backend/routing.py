import os

import requests

from geo import haversine_m

# router.project-osrm.org는 OSRM 프로젝트가 운영하는 "공개 데모" 서버로, 요청량 제한이
# 있는 비상용(non-production) 서비스임을 공식 문서가 명시한다 — 실제 운영 전환 시에는
# 자체 OSRM 인스턴스를 띄우거나 상용 라우팅 API로 교체해야 한다. 그 전까지는 데모 목적으로
# 그대로 쓰되, 실패/타임아웃 시 haversine 직선거리로 조용히 폴백한다(KMA/Open-Elevation과
# 동일한 "1회성 외부 API, 없거나 실패하면 근사치" 원칙).
OSRM_BASE_URL = os.environ.get("OSRM_BASE_URL", "https://router.project-osrm.org")

# OSRM이 실패했을 때 이동시간을 근사하는 데 쓰는 평균 시내 주행 속도 가정치(신호·회전 포함).
# 실측이 아니라 데모 단계의 근사이며, 실제 운영 시 현장 실측으로 보정해야 한다.
ASSUMED_URBAN_SPEED_MPS = 25.0 * 1000 / 3600  # 시속 25km
# 지점 하나에서 육안 점검·간단 기록에 걸리는 평균 시간 가정치(이동시간과 별개로 총 소요시간에 더함).
INSPECTION_SECONDS_PER_STOP = 300  # 5분


def fetch_osrm_matrices(points):
    """points: [{"lat":..,"lng":..}, ...]. OSRM Table API로 실도로망 기준 거리(m)·소요시간(초)
    행렬을 한 번의 요청에 함께 조회한다(annotations=distance,duration — 같은 응답에 둘 다
    들어 있어 이동시간 표시를 위해 별도 API 호출이 필요 없다). 실패 시 (None, None)."""
    if len(points) < 2:
        return None, None
    coords = ";".join(f"{p['lng']},{p['lat']}" for p in points)
    url = f"{OSRM_BASE_URL}/table/v1/driving/{coords}"
    try:
        resp = requests.get(url, params={"annotations": "distance,duration"}, timeout=5)
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") != "Ok":
            return None, None
        return data.get("distances"), data.get("durations")
    except Exception:
        return None, None


def build_matrix_fns(points):
    """points: [{"lat":..,"lng":..}, ...]. 성공하면 (distance_fn, duration_fn, "osrm"),
    실패하면 (haversine_m, 근사 duration_fn, "haversine") — 항상 호출 가능한 두 함수를
    반환한다(v2.15). duration_fn은 두 좌표 사이 예상 이동시간(초)을 반환한다."""
    distances, durations = fetch_osrm_matrices(points)
    if distances is None:
        def approx_duration_fn(lat1, lng1, lat2, lng2):
            return haversine_m(lat1, lng1, lat2, lng2) / ASSUMED_URBAN_SPEED_MPS
        return haversine_m, approx_duration_fn, "haversine"

    index_by_coord = {(p["lat"], p["lng"]): i for i, p in enumerate(points)}

    def distance_fn(lat1, lng1, lat2, lng2):
        i, j = index_by_coord.get((lat1, lng1)), index_by_coord.get((lat2, lng2))
        if i is None or j is None:
            return haversine_m(lat1, lng1, lat2, lng2)
        d = distances[i][j]
        return d if d is not None else haversine_m(lat1, lng1, lat2, lng2)

    def duration_fn(lat1, lng1, lat2, lng2):
        i, j = index_by_coord.get((lat1, lng1)), index_by_coord.get((lat2, lng2))
        d = durations[i][j] if (durations is not None and i is not None and j is not None) else None
        if d is not None:
            return d
        return distance_fn(lat1, lng1, lat2, lng2) / ASSUMED_URBAN_SPEED_MPS

    return distance_fn, duration_fn, "osrm"


def fetch_osrm_route_geometry(ordered_points):
    """ordered_points: [{"lat":..,"lng":..}, ...] 방문 순서대로. OSRM Route API(Table API와
    달리 실제 도로를 따라가는 선 좌표까지 준다)로 지도에 그릴 폴리라인을 조회한다(v2.16) —
    직선 연결은 강·건물을 가로지르는 등 실제로 다닐 수 없는 경로처럼 보이는 문제가 있어서,
    이미 거리·시간 계산에 쓰던 OSRM에서 geometry도 함께 받아온다. [[lat,lng], ...] 반환,
    실패 시 None(호출부가 직선 연결로 폴백)."""
    if len(ordered_points) < 2:
        return None
    coords = ";".join(f"{p['lng']},{p['lat']}" for p in ordered_points)
    url = f"{OSRM_BASE_URL}/route/v1/driving/{coords}"
    try:
        resp = requests.get(url, params={"overview": "full", "geometries": "geojson"}, timeout=8)
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") != "Ok" or not data.get("routes"):
            return None
        return [[lat, lng] for lng, lat in data["routes"][0]["geometry"]["coordinates"]]
    except Exception:
        return None


def kmeans_cluster(points, k, iterations=20):
    """points: [{"id":..,"lat":..,"lng":..}, ...]. k개 클러스터로 나눠 리스트의 리스트로 반환.

    지리적 묶음 단계는 haversine 그대로 쓴다 — "어느 대략적인 구역인가"를 가르는 거친
    단계라 직선거리 근사로 충분하고, 매 반복마다 OSRM을 호출하면 공개 데모 서버에
    부담만 커진다. 실도로망 정밀도가 실제로 필요한 건 각 구역 안에서의 방문 순서(아래
    geo_route)라, 거기에만 OSRM을 쓴다.
    """
    if k <= 1 or len(points) <= 1:
        return [points]
    k = min(k, len(points))
    # 입력 순서(우선순위 순서)에 따라 군집이 크게 달라지지 않도록, 전체 중심에서 가장 먼
    # 점을 첫 중심으로 두고 이후에는 기존 중심들과 가장 멀리 떨어진 점을 차례로 고른다.
    mean_lat = sum(p["lat"] for p in points) / len(points)
    mean_lng = sum(p["lng"] for p in points) / len(points)
    first = max(points, key=lambda p: haversine_m(mean_lat, mean_lng, p["lat"], p["lng"]))
    centroid_points = [first]
    while len(centroid_points) < k:
        nxt = max(
            (p for p in points if p not in centroid_points),
            key=lambda p: min(
                haversine_m(p["lat"], p["lng"], c["lat"], c["lng"])
                for c in centroid_points
            ),
        )
        centroid_points.append(nxt)
    centroids = [(p["lat"], p["lng"]) for p in centroid_points]
    buckets = [[] for _ in range(k)]
    for _ in range(iterations):
        buckets = [[] for _ in range(k)]
        for p in points:
            idx = min(range(k), key=lambda i: haversine_m(p["lat"], p["lng"], centroids[i][0], centroids[i][1]))
            buckets[idx].append(p)
        new_centroids = []
        for i, b in enumerate(buckets):
            if b:
                new_centroids.append((sum(x["lat"] for x in b) / len(b), sum(x["lng"] for x in b) / len(b)))
            else:
                new_centroids.append(centroids[i])
        if new_centroids == centroids:
            break
        centroids = new_centroids
    buckets = _balance_cluster_sizes(buckets, centroids)
    return [b for b in buckets if b]


def _balance_cluster_sizes(buckets, centroids):
    """군집 크기 편차를 최대 1까지 줄인다.

    k-means는 순수 지리적 밀집도로만 나누므로, 빗물받이가 몰려 있는 동네 하나가 통째로
    한 팀에 배정되면 그 팀만 수십 곳을 돌고 다른 팀은 몇 곳만 도는 극단적인 업무량
    불균형이 생긴다(실측: 65곳을 3팀으로 나눴을 때 8곳 vs 42곳까지 벌어짐, v2.14).
    가장 큰 군집에서 "받는 군집의 중심에 가장 가까운" 점부터 하나씩 옮겨 목표에 맞춘다 —
    무작위로 옮기지 않고 항상 그 팀에 지리적으로 가장 자연스럽게 붙는 점을 옮기므로,
    각 팀 안에서의 경로 품질(geo_route가 다시 다듬긴 하지만)이 크게 훼손되지 않는다."""
    while True:
        sizes = [len(b) for b in buckets]
        donor = max(range(len(buckets)), key=lambda i: sizes[i])
        receiver = min(range(len(buckets)), key=lambda i: sizes[i])
        if sizes[donor] - sizes[receiver] <= 1 or not buckets[donor]:
            break
        rc = centroids[receiver]
        point = min(buckets[donor], key=lambda p: haversine_m(p["lat"], p["lng"], rc[0], rc[1]))
        buckets[donor].remove(point)
        buckets[receiver].append(point)
    return buckets


def _route_distance(route, start, distance_fn):
    if not route:
        return 0.0
    total = 0.0
    current = start
    for index, point in enumerate(route):
        if current is not None:
            total += distance_fn(current[0], current[1], point["lat"], point["lng"])
        elif index > 0:
            previous = route[index - 1]
            total += distance_fn(previous["lat"], previous["lng"], point["lat"], point["lng"])
        current = (point["lat"], point["lng"])
    return total


def _two_opt(route, start, distance_fn):
    """구간을 통째로 뒤집는 이동으로 교차를 줄이는 2-opt 지역 개선.

    2-opt는 "구간을 통째로 뒤집는" 이동만 만들어낼 수 있어 방문 순서 자체를 부분적으로
    재배치하는 or-opt류 개선은 잡지 못한다 — 그건 아래 _or_opt가 담당. 고정된 시작점
    같은 건 없다(v2.12) — 어느 지점을 먼저 갈지도 순수하게 거리로 정한다."""
    best = list(route)
    best_distance = _route_distance(best, start, distance_fn)
    improved = True
    while improved:
        improved = False
        for i in range(0, len(best) - 1):
            for j in range(i + 1, len(best)):
                candidate = best[:i] + list(reversed(best[i : j + 1])) + best[j + 1 :]
                candidate_distance = _route_distance(candidate, start, distance_fn)
                if candidate_distance + 0.01 < best_distance:
                    best, best_distance = candidate, candidate_distance
                    improved = True
                    break
            if improved:
                break
    return best


def _or_opt(route, start, distance_fn, max_segment_len=3):
    """길이 1~3짜리 연속 구간을 통째로 뽑아 경로상 다른 위치에 재삽입해보는 or-opt 개선.

    2-opt(구간 뒤집기)만으로는 "이미 지나온 지역에 남겨둔 지점 몇 개를 나중에 완전히 동떨어진
    곳까지 갔다가 되짚어오는" 왕복을 못 없앤다 — 그 지점들을 애초에 지나가는 길목으로
    "옮겨 끼우는" 이동이 필요한데, 그게 2-opt의 이웃 구조(반전)에는 없는 이동이기 때문이다.
    or-opt는 그 이동을 직접 시도한다."""
    best = list(route)
    best_distance = _route_distance(best, start, distance_fn)
    improved = True
    while improved:
        improved = False
        n = len(best)
        for seg_len in range(1, max_segment_len + 1):
            for i in range(0, n - seg_len + 1):
                segment = best[i : i + seg_len]
                remainder = best[:i] + best[i + seg_len :]
                for j in range(0, len(remainder) + 1):
                    candidate = remainder[:j] + segment + remainder[j:]
                    candidate_distance = _route_distance(candidate, start, distance_fn)
                    if candidate_distance + 0.01 < best_distance:
                        best, best_distance = candidate, candidate_distance
                        improved = True
                        break
                if improved:
                    break
            if improved:
                break
    return best


def _local_search(route, start, distance_fn):
    """2-opt와 or-opt를 번갈아 적용해 어느 한쪽으로도 더 개선이 안 나올 때까지 지역 탐색한다.
    두 이웃 구조(반전/재배치)가 서로 다른 종류의 비효율을 잡아내므로 한 번씩만 돌리면
    다른 쪽이 새로 만든 개선 여지를 놓칠 수 있어 개선이 없어질 때까지 반복한다."""
    best = route
    best_distance = _route_distance(best, start, distance_fn)
    improved = True
    while improved:
        improved = False
        candidate = _two_opt(best, start, distance_fn)
        candidate_distance = _route_distance(candidate, start, distance_fn)
        if candidate_distance + 0.01 < best_distance:
            best, best_distance = candidate, candidate_distance
            improved = True
        candidate = _or_opt(best, start, distance_fn)
        candidate_distance = _route_distance(candidate, start, distance_fn)
        if candidate_distance + 0.01 < best_distance:
            best, best_distance = candidate, candidate_distance
            improved = True
    return best


def geo_route(cluster, start, distance_fn=haversine_m, duration_fn=None):
    """팀에 배정된 지점들을 순수 거리 기준으로만 순회 경로를 짠다(v2.12).

    이전 버전은 팀 내 최고 우선순위 지점을 첫 방문지로 강제 고정했는데, 그 지점이
    지리적으로 동떨어져 있으면 오히려 전체 동선이 그쪽으로 갔다가 되짚어오는 왕복을
    만들었다. 어떤 지점이 점검 대상에 들어갈지(게이트)와 얼마나 시급한지(우선순위 점수·
    "점검 필요" 목록 정렬)는 이미 다른 곳에서 처리되고, 같은 팀은 배정된 지점을 어차피
    전부 방문해야 하므로 방문 "순서"는 총 이동거리를 최소화하는 편이 현장에 더 도움이
    된다는 판단이다. 최근접 이웃으로 초기 경로를 만든 뒤 2-opt/or-opt로 다듬는다.

    duration_fn이 주어지면 각 구간의 예상 이동시간(초)도 함께 계산해 stop마다
    leg_duration_s로 붙이고, 총 이동시간(total_drive_duration_s)에 지점당 점검 시간
    가정치(INSPECTION_SECONDS_PER_STOP)를 더한 total_duration_s를 반환한다(v2.15) —
    "이 동선 전체가 몇 시간 걸리는가"는 순수 이동거리보다 현장에서 훨씬 실용적인 정보다."""
    if not cluster:
        result = {"stops": [], "total_distance_m": 0.0}
        if duration_fn is not None:
            result["total_drive_duration_s"] = 0.0
            result["total_duration_s"] = 0.0
        return result
    if start is not None:
        seed = start
    else:
        # 출발 지점이 안 주어지면(현재 프론트는 항상 이 경우) cluster의 "리스트 첫 원소"라는
        # 우연한 순서를 시작점으로 쓰지 않는다 — 그 점이 군집 한가운데에 있으면 최근접
        # 이웃이 한쪽으로 뻗어나간 뒤 반대쪽을 마저 돌러 되짚어오는 왕복이 생긴다(v2.14
        # 버그 리포트). 대신 군집 중심에서 가장 먼 가장자리 지점에서 시작해, 한쪽 끝에서
        # 다른 쪽 끝으로 자연스럽게 훑고 지나가도록 유도한다.
        mean_lat = sum(p["lat"] for p in cluster) / len(cluster)
        mean_lng = sum(p["lng"] for p in cluster) / len(cluster)
        edge_point = max(cluster, key=lambda p: haversine_m(mean_lat, mean_lng, p["lat"], p["lng"]))
        seed = (edge_point["lat"], edge_point["lng"])
    remaining = list(cluster)
    route = []
    current = seed
    while remaining:
        nxt = min(remaining, key=lambda p: distance_fn(current[0], current[1], p["lat"], p["lng"]))
        route.append(nxt)
        current = (nxt["lat"], nxt["lng"])
        remaining.remove(nxt)
    route = _local_search(route, start, distance_fn)

    stops = []
    current = start
    total_drive_s = 0.0
    for index, point in enumerate(route):
        if current is not None:
            leg = distance_fn(current[0], current[1], point["lat"], point["lng"])
            leg_s = duration_fn(current[0], current[1], point["lat"], point["lng"]) if duration_fn else None
        else:
            leg = 0.0
            leg_s = 0.0
        stop = {
            "order": index + 1, "drain_id": point["id"], "name": point["name"],
            "lat": point["lat"], "lng": point["lng"],
            "priority_score": point.get("priority_score"),
            "leg_distance_m": round(leg, 1),
        }
        if duration_fn is not None:
            stop["leg_duration_s"] = round(leg_s, 0)
            total_drive_s += leg_s
        stops.append(stop)
        current = (point["lat"], point["lng"])

    result = {
        "stops": stops,
        "total_distance_m": round(_route_distance(route, start, distance_fn), 1),
    }
    if duration_fn is not None:
        result["total_drive_duration_s"] = round(total_drive_s, 0)
        result["total_duration_s"] = round(total_drive_s + len(route) * INSPECTION_SECONDS_PER_STOP, 0)
    return result


def plan_routes(candidates, team_count, start=None):
    """candidates: 위와 동일 shape 딕셔너리 리스트. team_count 만큼 클러스터링 후 각 팀 내
    순수 거리 기준 순회(geo_route). 반환: (teams, distance_source) — distance_source는
    "osrm" 또는 "haversine"(OSRM 실패/미가용 시 폴백됐다는 뜻, 응답에 그대로 노출해 정직하게 알림)."""
    if not candidates:
        return [], "haversine"

    clusters = kmeans_cluster(candidates, min(team_count, len(candidates)))
    while len(clusters) < team_count:
        clusters.append([])

    all_points = ([{"lat": start[0], "lng": start[1]}] if start else []) + candidates
    distance_fn, duration_fn, distance_source = build_matrix_fns(all_points)

    teams = []
    for i, cluster in enumerate(clusters):
        result = geo_route(cluster, start, distance_fn=distance_fn, duration_fn=duration_fn)
        # 거리·시간 계산이 이미 OSRM 실도로망 기준일 때만 geometry도 같은 도로망에서
        # 받아온다 — Table API가 이미 실패한 상황이면 Route API도 대개 마찬가지라 헛된
        # 호출을 줄인다. 실패해도 조용히 생략하고, 프론트가 직선 연결로 폴백한다.
        if distance_source == "osrm" and len(result["stops"]) >= 2:
            ordered_points = (
                ([{"lat": start[0], "lng": start[1]}] if start else [])
                + [{"lat": s["lat"], "lng": s["lng"]} for s in result["stops"]]
            )
            geometry = fetch_osrm_route_geometry(ordered_points)
            if geometry is not None:
                result["route_geometry"] = geometry
        teams.append({"team_id": i + 1, **result})
    return teams, distance_source
